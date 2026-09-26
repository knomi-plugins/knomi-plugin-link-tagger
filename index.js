'use strict'

/**
 * link-tagger 整理阶段插件（v0.4：定向织网 + 孤岛补链 + 死链体检）
 *
 * 三层织网：
 *   L1 规则匹配（零成本）：suggest_relations —— 标题字面提及扫描
 *   L2 LLM 语义（单次调用批量建议，成本纪律对齐 GraphRAG 关系抽取/LightRAG 增量合并，
 *      但按个人库规模收敛为「一次调用出全部候选」）：auto_suggest_relations
 *   L3 一键织网：weave_graph —— 合并建议自动应用 top N，每仓库一次重索引；
 *      支持 focus 聚焦文档（优先为其建边）
 * 孤岛补链：weaveOrphans 导出方法（图谱页「一键补链」按钮直达）——自动定位零度孤岛，
 *          LLM 建议注入学习目标上下文（孤岛/薄弱清单），触及孤岛的建议优先应用。
 * 健康检查：lint_links（零 LLM）——扫描 [[WikiLink]] 死链（目标不存在），只报告不自动改。
 * 自动维护：auto_weave 守护（默认开，预算硬约束：每 1h 检查增长、≥20h 一次才消耗 LLM、
 *          新增文档 ≥ 阈值才跑、首次运行仅记基线），织网同样朝孤岛/薄弱方向优先。
 * 治理：全部写入为「相关」小节追加式（不改正文）+ 审计 + 可就地删除。
 */

const fsp = require('fs/promises')
const path = require('path')

async function repoOf(context, doc) {
  const repos = (await context.listRepositories()) || []
  const norm = String(doc.filePath || '').replace(/\\/g, '/').toLowerCase()
  return repos.find((r) => norm.startsWith(String(r.localPath || '').replace(/\\/g, '/').toLowerCase()))
}

async function readDoc(context, doc) {
  try { return await fsp.readFile(doc.filePath, 'utf-8') } catch { return '' }
}

/** 在内容中查找其他文档标题的提及（中文标题直接找，英文按词边界） */
function findMentions(content, title) {
  const escaped = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = /[\u4e00-\u9fff]/.test(title)
    ? new RegExp(escaped)
    : new RegExp(`\\b${escaped}\\b`, 'i')
  const m = re.exec(content)
  if (!m) return null
  const start = Math.max(0, m.index - 20)
  return content.slice(start, m.index + title.length + 20).replace(/\s+/g, ' ').trim()
}

/** 追加 WikiLink 的纯内容变换（apply_link/批量/织网共用；追加式不改正文） */
function withWikiLink(content, linkTitle) {
  if (content.includes(`[[${linkTitle}`)) return { content, alreadyLinked: true }
  const section = content.includes('## 相关')
    ? content.replace('## 相关', `## 相关\n- [[${linkTitle}]]`)
    : `${content.replace(/\s+$/, '')}\n\n## 相关\n\n- [[${linkTitle}]]\n`
  return { content: section, alreadyLinked: false }
}

const baseTitle = (t) => String(t || '').replace(/\.md$/i, '')

/** L1 规则扫描（字面提及；抽取自原 suggest_relations，行为不变） */
async function ruleSuggestions(context, docs, perRepoCap) {
  const byRepo = new Map()
  for (const d of docs) {
    const repo = await repoOf(context, d)
    if (!repo) continue
    if (!byRepo.has(repo.id)) byRepo.set(repo.id, [])
    if (byRepo.get(repo.id).length < perRepoCap) byRepo.get(repo.id).push(d)
  }
  const sampled = [...byRepo.values()].flat()
  const suggestions = []
  let unreadable = 0
  for (const doc of sampled) {
    const content = await readDoc(context, doc)
    if (!content) { unreadable++; continue }
    const repoDoc = await repoOf(context, doc)
    for (const other of sampled) {
      if (other.id === doc.id) continue
      const repoOther = await repoOf(context, other)
      if (!repoDoc || !repoOther || repoDoc.id !== repoOther.id) continue
      const title = baseTitle(other.title)
      if (!title || title.length < 2) continue
      if (String(doc.title || '').includes(title)) continue
      if (content.includes(`[${title}]`) || content.includes(`[[${title}`)) continue
      const snippet = findMentions(content, title)
      if (snippet) suggestions.push({ documentTitle: doc.title || doc.filePath, documentPath: doc.filePath, linkTo: title, targetPath: other.filePath, snippet })
    }
  }
  return { suggestions, sampled, unreadable }
}

/** 文档画像（LLM 织网素材）：标题 + 章节标题 + 首段摘要（本地读取，零成本） */
async function docProfile(context, doc) {
  const content = await readDoc(context, doc)
  const headings = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 5).map((m) => m[1].trim())
  const body = content.replace(/^#{1,3}\s+.+$/gm, '').replace(/\s+/g, ' ').trim()
  return { doc, content, headings, excerpt: body.slice(0, 160) }
}

/**
 * L2 LLM 语义建议：每仓库把文档画像合并为一次 LLM 调用（成本纪律：一次调用出全部候选，
 * 而非逐对调用）。输出经验证的建议（同仓库/存在/非自指/未链接）。
 * @param {object} [purpose] 学习目标上下文（注入提示词，让织网朝学习意图生长）：
 *   focusTitles 孤立/聚焦文档标题，weakTitles 薄弱文档标题
 * @returns {Promise<{suggestions: Array, scanned: number, total: number, llmUsed: boolean, llmError?: string}>}
 */
async function llmSuggestions(context, docs, perRepoCap, purpose) {
  const byRepo = new Map()
  for (const d of docs) {
    const repo = await repoOf(context, d)
    if (!repo) continue
    if (!byRepo.has(repo.id)) byRepo.set(repo.id, [])
    if (byRepo.get(repo.id).length < perRepoCap) byRepo.get(repo.id).push(d)
  }
  // 全量硬预算：多仓库场景下送入 LLM 的文档总数上限（仓库间轮转采样，防提示词超长）
  const TOTAL_CAP = 40
  const picked = []
  for (let i = 0; picked.length < TOTAL_CAP; i++) {
    let added = false
    for (const repoDocs of byRepo.values()) {
      if (repoDocs[i]) {
        picked.push(repoDocs[i])
        added = true
        if (picked.length >= TOTAL_CAP) break
      }
    }
    if (!added) break
  }
  const profiles = []
  for (const d of picked) profiles.push(await docProfile(context, d))
  const scanned = profiles.length
  const total = docs.length
  if (scanned < 2) return { suggestions: [], scanned, total, llmUsed: false }

  const numbered = profiles.map((p, i) => {
    const title = baseTitle(p.doc.title)
    return `#${i + 1} 《${title}》${p.headings.length ? ` 章节: ${p.headings.join('/')}` : ''} 摘要: ${p.excerpt || '（无正文）'}`
  })
  // 学习目标上下文（purpose 注入）：孤岛与薄弱清单截断防提示词膨胀
  const purposeLines = []
  const focusTitles = (purpose && Array.isArray(purpose.focusTitles) ? purpose.focusTitles : []).slice(0, 12)
  const weakTitles = (purpose && Array.isArray(purpose.weakTitles) ? purpose.weakTitles : []).slice(0, 8)
  if (focusTitles.length > 0) purposeLines.push(`孤立文档（图谱零度节点，优先为它们建立关联）：${focusTitles.join('、')}`)
  if (weakTitles.length > 0) purposeLines.push(`薄弱文档（答题正确率低，优先串联其前置/相关知识）：${weakTitles.join('、')}`)
  const messages = [
    {
      role: 'system',
      content: '你是知识库的图谱管理员。给你同一知识体系内的文档清单（编号/标题/章节/摘要）。找出语义相关、值得互相链接的文档对（关系类型：相关/前置/对比/引用）。只输出 JSON 数组，每项 {"source": 编号数字, "target": 编号数字, "type": "相关|前置|对比|引用", "reason": "一句话理由"}，最多 10 条，按价值从高到低排序；没有发现就输出 []。禁止输出 JSON 以外的任何文字。',
    },
    { role: 'user', content: numbered.join('\n') + (purposeLines.length > 0 ? `\n\n学习目标上下文：\n- ${purposeLines.join('\n- ')}` : '') },
  ]

  // 成本与稳定性纪律（对齐宿主 aiReview 二次重试模式）：本地/云端模型延迟抖动大（4-26s 实测）。
  // 预算约束（round8）：沙箱宿主 CALL_TIMEOUT_MS=120s 的前提是「llm 上限 90s」——单次超时收敛到
  // 90s 且仅对快速失败（网络抖动/空输出）重试一次，超时型失败不重试（重试只会再超时），
  // 保证整链预算落在沙箱 RPC 帽内，外层调用（agent 工具/图谱页一键补链）不被先超时掐死
  const LLM_TIMEOUT_MS = 90_000
  const isTimeoutErr = (e) => /abort|timeout|timed?\s*out|超时/i.test(String((e && e.message) || e))
  let out = ''
  let lastErr = ''
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const msgs = attempt > 0
      ? [...messages, { role: 'user', content: '上一次输出无法使用。请严格只输出一个 JSON 数组，第一个字符必须是 [，禁止任何解释、前缀或 markdown 代码围栏。' }]
      : messages
    try {
      out = String(await context.llm.complete({ messages: msgs, temperature: 0.2, maxTokens: 4096, timeoutMs: LLM_TIMEOUT_MS })).trim()
    } catch (err) {
      lastErr = String((err && err.message) || err)
      if (isTimeoutErr(err)) break
    }
  }
  if (!out) {
    return { suggestions: [], scanned, total, llmUsed: true, llmError: lastErr || 'LLM 连续两次返回空输出' }
  }
  let pairs = []
  const fenced = out.replace(/```(json)?/g, '').trim()
  let parsed = null
  try {
    parsed = JSON.parse(fenced)
  } catch { /* 思考型模型可能 token 截断——尝试截断补救 */ }
  if (!Array.isArray(parsed)) {
    const lastBrace = fenced.lastIndexOf('}')
    if (lastBrace > 0) {
      try { parsed = JSON.parse(fenced.slice(0, lastBrace + 1) + ']') } catch { parsed = null }
    }
  }
  if (!Array.isArray(parsed)) {
    return { suggestions: [], scanned, total, llmUsed: true, llmError: `LLM 输出无法解析为 JSON（原文前 120 字: ${out.slice(0, 120)}）` }
  }
  pairs = parsed
  if (!Array.isArray(pairs)) return { suggestions: [], scanned, total, llmUsed: true, llmError: 'LLM 输出不是数组' }

  const repoIdOf = async (p) => { const r = await repoOf(context, p.doc); return r ? r.id : null }
  const suggestions = []
  const seen = new Set()
  for (const pair of pairs.slice(0, 10)) {
    const s = profiles[(Number(pair && pair.source) || 0) - 1]
    const t = profiles[(Number(pair && pair.target) || 0) - 1]
    if (!s || !t || s.doc.id === t.doc.id) continue
    const sRepo = await repoIdOf(s)
    const tRepo = await repoIdOf(t)
    if (!sRepo || sRepo !== tRepo) continue
    const linkTitle = baseTitle(t.doc.title)
    if (!linkTitle || linkTitle.length < 2) continue
    if (baseTitle(s.doc.title).includes(linkTitle)) continue // 自指保护
    if (s.content.includes(`[[${linkTitle}`)) continue // 已有链接
    const key = `${s.doc.filePath}->${t.doc.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      documentTitle: s.doc.title || s.doc.filePath,
      documentPath: s.doc.filePath,
      linkTo: linkTitle,
      targetPath: t.doc.filePath,
      snippet: `${pair.type || '相关'}：${String(pair.reason || '语义相关').slice(0, 60)}`,
      llm: true,
    })
  }
  return { suggestions, scanned, total, llmUsed: true }
}

/** 合并去重（LLM 优先，规则补位；按 来源→目标 键去重） */
function mergeSuggestions(llm, rule) {
  const merged = []
  const seen = new Set()
  for (const s of [...llm, ...rule]) {
    const key = `${s.documentPath}->${s.targetPath}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()

/** 孤岛文档（图谱零度节点：与 document_relations 无任何边；查询失败按无孤岛处理） */
async function orphanDocs(context) {
  try {
    const rows = await context.query(
      `SELECT d.id AS id, d.title AS title, d.file_path AS filePath
       FROM documents d
       LEFT JOIN document_relations dr ON dr.source_id = d.id OR dr.target_id = d.id
       WHERE dr.id IS NULL`
    )
    return (Array.isArray(rows) ? rows : []).filter((r) => r && r.id)
  } catch {
    return []
  }
}

/** 薄弱文档标题（正确率<60% 的题目所在文档；织网学习目标上下文；失败按空处理） */
async function weakDocTitles(context, limit = 8) {
  try {
    const rows = await context.query(
      `SELECT DISTINCT d.title AS title FROM questions q
       JOIN documents d ON q.document_id = d.id
       WHERE q.status = 'confirmed' AND (
         SELECT AVG(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END)
         FROM question_attempts a WHERE a.question_id = q.id
       ) < 60 LIMIT ${Math.max(1, Number(limit) || 8)}`
    )
    return (Array.isArray(rows) ? rows : []).map((r) => baseTitle(r.title)).filter(Boolean)
  } catch {
    return []
  }
}

/** 建议是否触及焦点集（来源文档在 focusPaths，或目标标题在 focusTitles） */
function touchesFocus(s, focusPaths, focusTitles) {
  return focusPaths.has(normPath(s.documentPath)) || focusTitles.has(String(s.linkTo || '').toLowerCase())
}

/** 焦点优先排序（触及孤岛/聚焦文档的建议排前；其余保持原序） */
function prioritizeSuggestions(merged, focusPaths, focusTitles) {
  if (focusPaths.size === 0 && focusTitles.size === 0) return merged
  const hit = merged.filter((s) => touchesFocus(s, focusPaths, focusTitles))
  const rest = merged.filter((s) => !touchesFocus(s, focusPaths, focusTitles))
  return [...hit, ...rest]
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 死链扫描核心（lint_links 工具与图谱页死链体检共用；零 LLM）。
 *  ⚠️ 解析全域必须=全库文档（所有仓库）：标题/文件名能解析到即不算死链。
 *  0.5.0 误报事故：存在名单曾随扫描窗口截断为前 300 篇，排序其后（如全库序号 321 的
 *  「20. 分区表实践」）的目标全部被误判死链——存在判定与扫描范围从此严格分离。
 *  全库扫描为沙箱白名单内的本地文件读（fs/fs-promises），1668 篇实测秒级；
 *  5000 篇护栏仅为极端库兜底，超出部分如实披露。 */
const LINT_SCAN_GUARD = 5000

/** 剥离围栏代码块与行内代码：bash 的 [[ -z "$X" ]] 条件与 Python 的 [[...]] 字面量不是 WikiLink
 *  （0.5.1 误报实证：shell/代码笔记里成对双括号被当链接，占剩余误报大头）。字符置换保行结构。 */
function stripCodeForLint(content) {
  return content
    .replace(/`{3,}[\s\S]*?`{3,}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/~{3,}[\s\S]*?~{3,}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

async function lintScan(context) {
  const all = (await context.getDocuments()) || []
  const universe = all.slice(0, LINT_SCAN_GUARD)
  const titleSet = new Set()
  const baseSet = new Set()
  // 路径解析全域：文件精确路径 + 祖先目录（含 ≥2 段的后缀形式）——
  // 知识域目录链接（如 [[ITMastery/核心技术/Redis]] 指向笔记簇目录）与相对路径（[[../软件设计]]）
  // 都是合法写法，0.5.1 误报实证
  const pathSet = new Set()
  const dirSet = new Set()
  for (const d of universe) {
    const t = baseTitle(d.title).toLowerCase()
    if (t) titleSet.add(t)
    const p = normPath(d.filePath)
    const noExt = p.replace(/\.md$/i, '')
    pathSet.add(noExt)
    pathSet.add(p)
    const segs = noExt.split('/')
    for (let i = 1; i <= segs.length - 1; i++) {
      dirSet.add(segs.slice(0, i).join('/'))
      for (let s = 0; s <= i - 2; s++) {
        const suf = segs.slice(s, i).join('/')
        if (suf.includes('/')) dirSet.add(suf)
      }
    }
    const base = (segs[segs.length - 1] || '').replace(/\.md$/i, '')
    if (base) baseSet.add(base)
  }
  const alivePath = (n) => pathSet.has(n) || pathSet.has(n + '.md') || dirSet.has(n)
  const dead = []
  let scanned = 0
  for (const doc of universe) {
    const raw = await readDoc(context, doc)
    if (!raw) continue
    scanned++
    const content = stripCodeForLint(raw)
    const docDir = normPath(doc.filePath).split('/').slice(0, -1).join('/')
    const seen = new Set()
    for (const m of content.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      // [[目标|别名]] 取目标；[[目标#章节]] 去锚点；[[标题\]] 的 markdown 转义与收尾 / \ 分隔符不属目标名
      let target = m[1].split('|')[0].split('#')[0].trim()
      if (!target) continue
      target = target.replace(/\\([[\]()#|\\])/g, '$1').replace(/[\\/]+$/, '').trim()
      if (!target) continue
      if (/%[0-9A-Fa-f]{2}/.test(target)) {
        try { target = decodeURIComponent(target) } catch { /* 编码残缺按原文判定 */ }
      }
      const key = target.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const normTarget = key.replace(/\\/g, '/')
      const isRelative = /^\.\.?\//.test(normTarget)
      const resolved = isRelative ? path.posix.normalize(docDir + '/' + normTarget) : normTarget
      const segs = resolved.split('/')
      const base = (segs[segs.length - 1] || '').replace(/\.md$/i, '')
      if (isRelative || normTarget.includes('/')) {
        // 路径式/相对式：文件精确 → 目录枢纽 → 标题/文件名兜底
        if (alivePath(resolved) || titleSet.has(base) || baseSet.has(base)) continue
      } else if (titleSet.has(base) || baseSet.has(base)) continue
      dead.push({ documentTitle: doc.title || doc.filePath, documentPath: doc.filePath, linkTo: target })
    }
  }
  return { dead, scanned, total: universe.length, guardReached: all.length > LINT_SCAN_GUARD }
}

/** 仅在「## 相关」小节内移除死链行（^- [[目标]]… 形态，插件写入领土）；正文手写链接不触碰 */
function removeDeadFromRelated(content, targets) {
  const idx = content.indexOf('## 相关')
  if (idx === -1) return { content, removed: [] }
  const head = content.slice(0, idx)
  let tail = content.slice(idx)
  // 小节边界：到下一个 «\n## » 为止，防误删后续小节里的同名行
  const nextHeader = tail.indexOf('\n## ', 1)
  let after = ''
  if (nextHeader !== -1) {
    after = tail.slice(nextHeader)
    tail = tail.slice(0, nextHeader)
  }
  const removed = []
  for (const t of targets) {
    const lineRe = new RegExp(`^[-*] \\[\\[${escapeRe(t)}\\]\\][^\\n]*\\r?\\n?`, 'm')
    if (!lineRe.test(tail)) continue
    tail = tail.replace(lineRe, '')
    removed.push(t)
  }
  if (removed.length === 0) return { content, removed: [] }
  return { content: head + tail.replace(/\n{3,}/g, '\n\n') + after, removed }
}

/**
 * 死链治理执行（fix 模式核心）：只清理「## 相关」小节内插件写入的死链行，
 * 正文手写死链保留并归入手写清单（防误删）。每仓库至多一次重索引。
 * @returns {Promise<{fixed: Array<{documentTitle, linkTitle}>, manual: Array<{documentTitle, documentPath, linkTo}>, repos: number}>}
 */
async function lintFix(context, deadEntries) {
  const byDoc = new Map()
  for (const d of deadEntries) {
    if (!byDoc.has(d.documentPath)) byDoc.set(d.documentPath, new Map())
    byDoc.get(d.documentPath).set(d.linkTo, d)
  }
  const docs = (await context.getDocuments()) || []
  const fixed = []
  const manual = []
  const reposToReindex = new Map()
  for (const [docPath, targetMap] of byDoc) {
    const doc = docs.find((d) => d.filePath === docPath)
    if (!doc) { for (const d of targetMap.values()) manual.push(d); continue }
    const content = await readDoc(context, doc)
    if (!content) { for (const d of targetMap.values()) manual.push(d); continue }
    const { content: next, removed } = removeDeadFromRelated(content, [...targetMap.keys()])
    for (const t of targetMap.keys()) {
      if (removed.includes(t)) fixed.push({ documentTitle: doc.title || doc.filePath, linkTitle: t })
      else manual.push(targetMap.get(t))
    }
    if (removed.length > 0) {
      await fsp.writeFile(doc.filePath, next, 'utf-8')
      const repo = await repoOf(context, doc)
      if (repo) reposToReindex.set(repo.id, repo)
    }
  }
  for (const repo of reposToReindex.values()) await context.reindexRepository(repo.id)
  return { fixed, manual, repos: reposToReindex.size }
}

/** 应用一组链接（批量/织网共用）：写入 + 每仓库一次重索引 + 逐条对账 */
async function applyLinkPairs(context, links) {
  const docs = (await context.getDocuments()) || []
  const reposToReindex = new Map()
  const applied = []
  const skipped = []
  for (const l of links) {
    const doc = docs.find((d) => d.filePath === l.documentPath)
    const target = docs.find((d) => d.filePath === l.targetPath)
    if (!doc || !target) {
      skipped.push({ path: l.documentPath, reason: !doc ? '来源文档不在索引中' : '目标文档不在索引中' })
      continue
    }
    const linkTitle = baseTitle(target.title)
    const content = await readDoc(context, doc)
    const { content: next, alreadyLinked } = withWikiLink(content, linkTitle)
    if (alreadyLinked) {
      skipped.push({ path: doc.filePath, reason: `已有指向「${linkTitle}」的链接` })
      continue
    }
    await fsp.writeFile(doc.filePath, next, 'utf-8')
    applied.push({ title: doc.title, documentPath: doc.filePath, linkTitle })
    const repo = await repoOf(context, doc)
    if (repo) reposToReindex.set(repo.id, repo)
  }
  for (const repo of reposToReindex.values()) await context.reindexRepository(repo.id)
  return { applied, skipped, repos: [...reposToReindex.values()] }
}

let ctx = null // 图谱页「一键补链」经 plugin.invoke 调用 weaveOrphans；激活期捕获上下文

module.exports = {
  id: 'link-tagger',
  name: '关联建议官',
  version: '0.5.2',
  description: '整理阶段：规则匹配 + LLM 语义织网（自动维护知识地图，孤岛/薄弱方向优先），孤岛一键补链、死链体检，建议可一键/批量应用，让图谱长出边',

  /**
   * 孤岛补链（图谱页一键补链按钮直达；plugin.invoke 导出方法，非 agent 工具）。
   * @param {{paths?: string[], applyCount?: number}} [payload]
   *   paths 指定孤岛文档路径（不传=自动检测全部零度孤岛）；applyCount 最多写入条数（默认 5，上限 20）
   * @returns {Promise<{message?: string, error?: string}>}
   */
  async weaveOrphans(payload) {
    if (!ctx) return { error: '关联建议官未激活' }
    const context = ctx
    const p = payload && typeof payload === 'object' ? payload : {}
    const applyCount = Math.min(Math.max(Number(p.applyCount) || 5, 1), 20)
    try {
      const docs = (await context.getDocuments()) || []
      const want = new Set((Array.isArray(p.paths) ? p.paths : []).map(normPath).filter(Boolean))
      let focusRows
      if (want.size > 0) {
        focusRows = docs.filter((d) => want.has(normPath(d.filePath)))
        if (focusRows.length === 0) return { error: '指定的文档不在索引中' }
      } else {
        focusRows = await orphanDocs(context)
      }
      if (focusRows.length === 0) return { message: '✅ 图谱没有孤岛文档——所有文档都已有边相连，无需补链。' }
      const focusTitles = focusRows.map((d) => baseTitle(d.title)).filter(Boolean)
      const focusPaths = new Set(focusRows.map((d) => normPath(d.filePath)))
      const focusTitlesSet = new Set(focusTitles.map((t) => t.toLowerCase()))
      const weakTitles = await weakDocTitles(context)
      const llm = await llmSuggestions(context, docs, 20, { focusTitles, weakTitles })
      if (llm.llmError) return { error: `LLM 织网失败：${llm.llmError}` }
      const rule = await ruleSuggestions(context, docs, 12)
      const merged = prioritizeSuggestions(mergeSuggestions(llm.suggestions, rule.suggestions), focusPaths, focusTitlesSet)
      if (merged.length === 0) {
        return { message: `孤岛 ${focusRows.length} 篇已连同薄弱清单一起送入双重扫描（${llm.scanned}/${llm.total} 篇），本轮没有发现值得连接的关联。可稍后再试或手动添加 [[链接]]。` }
      }
      const toApply = merged.slice(0, applyCount).map((s) => ({ documentPath: s.documentPath, targetPath: s.targetPath }))
      const { applied, skipped, repos } = await applyLinkPairs(context, toApply)
      if (applied.length === 0) {
        return { message: `本轮 ${skipped.length} 条建议均不适用（${skipped.slice(0, 2).map((s) => s.reason).join('；')}），未做改动。` }
      }
      const orphanHits = applied.filter((a) => focusPaths.has(normPath(a.documentPath)) || focusTitlesSet.has(String(a.linkTitle).toLowerCase())).length
      const parts = [`🕸️ 织网完成：写入 ${applied.length} 条 WikiLink（重索引 ${repos.length} 个仓库），其中 ${orphanHits} 条直连孤岛文档（孤岛共 ${focusRows.length} 篇）。`]
      parts.push(applied.slice(0, 5).map((a) => `- 《${a.title}》→ [[${a.linkTitle}]]`).join('\n'))
      if (applied.length > 5) parts.push(`…（共 ${applied.length} 条）`)
      if (skipped.length > 0) parts.push(`⚠️ 跳过 ${skipped.length} 条（${skipped.slice(0, 2).map((s) => s.reason).join('；')}${skipped.length > 2 ? ' 等' : ''}）`)
      parts.push('图谱数据即将刷新，孤岛会连入关系网。')
      return { message: parts.join('\n') }
    } catch (err) {
      return { error: `孤岛补链失败: ${(err && err.message) || err}` }
    }
  },

  /**
   * 死链体检（图谱页「死链体检」按钮直达；plugin.invoke 导出方法，非 agent 工具）。
   * @param {{fix?: boolean}} [payload] fix=true 时自动清理「相关」小节内插件写入的死链行
   * @returns {Promise<{message?: string, error?: string, dead?: Array<{documentTitle, documentPath, linkTo}>}>}
   *   dead：当前死链清单（fix 后为剩余手写死链），供界面渲染
   */
  async lintLinks(payload) {
    if (!ctx) return { error: '关联建议官未激活' }
    const context = ctx
    const fix = payload && typeof payload === 'object' && payload.fix === true
    try {
      const scan = await lintScan(context)
      if (scan.dead.length === 0) {
        return { message: `✅ 链接体检通过：已扫描 ${scan.scanned}/${scan.total} 篇文档，全部 [[WikiLink]] 有效，没有死链。`, dead: [] }
      }
      const capNote = scan.guardReached ? '（库内文档超过 5000 篇护栏）' : ''
      if (!fix) {
        return {
          message: `🔍 发现 ${scan.dead.length} 个死链（已扫描 ${scan.scanned}/${scan.total} 篇${capNote}）。「一键清理」只移除「相关」小节内插件写入的死链行，正文手写链接只报告不自动改。`,
          dead: scan.dead.slice(0, 50),
        }
      }
      const { fixed, manual, repos } = await lintFix(context, scan.dead)
      const parts = []
      if (fixed.length > 0) {
        parts.push(`🧹 已清理 ${fixed.length} 条插件写入的死链（重索引 ${repos} 个仓库）：\n${fixed.slice(0, 8).map((f) => `- 《${f.documentTitle}》移除 [[${f.linkTitle}]]`).join('\n')}${fixed.length > 8 ? `\n…（共 ${fixed.length} 条）` : ''}`)
      }
      if (manual.length > 0) {
        parts.push(`✋ ${manual.length} 条位于正文手写区，未自动改动（防误删）：\n${manual.slice(0, 5).map((d) => `- 《${d.documentTitle}》→ [[${d.linkTo}]]`).join('\n')}${manual.length > 5 ? `\n…（共 ${manual.length} 条）` : ''}`)
      }
      if (fixed.length === 0) parts.push('本轮没有可自动清理的死链（全部位于正文手写区）。')
      return { message: parts.join('\n\n'), dead: manual.slice(0, 50) }
    } catch (err) {
      return { error: `死链治理失败: ${(err && err.message) || err}` }
    }
  },

  async activate(context) {
    ctx = context
    context.registerAgentTool(
      {
        name: 'suggest_relations',
        description: '扫描知识库文档，发现"A 文档正文提到了 B 文档标题但两者没有链接"的整理缺口（规则匹配，零 LLM 成本），产出 WikiLink 建议（show_view 表格）。整理知识库、补全图谱时使用。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '每仓库最多扫描的文档数，默认 12，上限 30' }
          }
        }
      },
      async (args) => {
        const totalDocs = ((await context.getDocuments()) || []).length
        const perRepo = Math.min(Number(args.limit) || 12, 30)
        const { suggestions, unreadable } = await ruleSuggestions(context, (await context.getDocuments()) || [], perRepo)
        const scanned = Math.min(perRepo, totalDocs)
        const skipNote = unreadable ? `（${unreadable} 篇读取失败已跳过）` : ''
        if (suggestions.length === 0) {
          return { output: `已扫描 ${scanned}/${totalDocs} 篇文档${skipNote}，没有发现"提及但未链接"的整理缺口。图谱很干净！` }
        }
        const moreText = suggestions.length > 10 ? `\n…（其余 ${suggestions.length - 10} 条见下方表格）` : ''
        return {
          output: `发现 ${suggestions.length} 处整理缺口（已扫描 ${scanned}/${totalDocs} 篇${skipNote}）：\n` +
            suggestions.slice(0, 10).map((s) => `- 《${s.documentTitle}》提到「${s.linkTo}」→ 建议加 [[${s.linkTo}]]`).join('\n') +
            moreText +
            `\n\n可对我说「批量应用全部建议」走 apply_links_bulk（每仓库只重索引一次）；或用 weave_graph 一键织网（含 LLM 语义建议）。`,
          ui: { intent: 'show_view', view: { title: '整理建议（提及但未链接）', columns: [
            { key: 'documentTitle', label: '来源文档' },
            { key: 'linkTo', label: '建议链接到' },
            { key: 'snippet', label: '命中片段' }
          ], rows: suggestions.slice(0, 30) } }
        }
      }
    )

    context.registerAgentTool(
      {
        name: 'auto_suggest_relations',
        description: 'LLM 语义织网：读取各仓库文档画像（标题/章节/摘要），单次 LLM 调用发现规则匹配抓不到的语义关联（相关/前置/对比/引用），与规则建议合并去重后产出（show_view）。批量导入后、定期知识治理时使用；消耗少量 LLM 费用。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '每仓库最多送入 LLM 的文档数，默认 20，上限 40' }
          }
        }
      },
      async (args) => {
        const perRepo = Math.min(Number(args.limit) || 20, 40)
        const docs = (await context.getDocuments()) || []
        const llm = await llmSuggestions(context, docs, perRepo)
        if (llm.llmError) {
          return { output: '', error: `LLM 织网失败：${llm.llmError}` }
        }
        const rule = await ruleSuggestions(context, docs, 12)
        const merged = mergeSuggestions(llm.suggestions, rule.suggestions)
        if (merged.length === 0) {
          return { output: `已扫描 ${llm.scanned}/${llm.total} 篇文档（LLM 语义 + 规则匹配双重扫描），没有发现值得链接的关联。图谱很干净！` }
        }
        const llmCount = merged.filter((s) => s.llm).length
        return {
          output: `🧠 织网建议 ${merged.length} 条（LLM 语义 ${llmCount} 条 + 规则匹配 ${merged.length - llmCount} 条；已扫描 ${llm.scanned}/${llm.total} 篇）：\n` +
            merged.slice(0, 10).map((s) => `- 《${s.documentTitle}》→ [[${s.linkTo}]]（${s.snippet}）`).join('\n') +
            (merged.length > 10 ? `\n…（其余 ${merged.length - 10} 条见下方表格）` : '') +
            `\n\n可对我说「一键织网」走 weave_graph 自动应用，或用 apply_links_bulk 批量应用。`,
          ui: { intent: 'show_view', view: { title: '织网建议（LLM 语义 + 规则）', columns: [
            { key: 'documentTitle', label: '来源文档' },
            { key: 'linkTo', label: '建议链接到' },
            { key: 'snippet', label: '关系/理由' }
          ], rows: merged.slice(0, 30) } }
        }
      }
    )

    context.registerAgentTool(
      {
        name: 'weave_graph',
        description: '一键织网：LLM 语义建议 + 规则建议合并，自动应用价值最高的 N 条（写入 WikiLink，每仓库一次重索引），回报结果——让知识图谱自动长出边。可传 focus_paths 聚焦文档（如孤岛补链：优先为它们建边）。消耗少量 LLM 费用。',
        parameters: {
          type: 'object',
          properties: {
            apply_count: { type: 'number', description: '自动应用的链接数，默认 5，上限 20' },
            limit: { type: 'number', description: '每仓库送入 LLM 的文档数，默认 20，上限 40' },
            focus_paths: {
              type: 'array',
              items: { type: 'string' },
              description: '聚焦文档（标题或路径片段，可多个）：优先为它们建立关联；不传则全局织网'
            }
          }
        }
      },
      async (args) => {
        const applyCount = Math.min(Math.max(Number(args.apply_count) || 5, 1), 20)
        const perRepo = Math.min(Number(args.limit) || 20, 40)
        const docs = (await context.getDocuments()) || []
        // 聚焦文档解析：标题或路径片段匹配 → 学习目标上下文（focus）+ 结果优先级
        const fragments = (Array.isArray(args.focus_paths) ? args.focus_paths : [])
          .map((f) => String(f).trim().toLowerCase()).filter(Boolean)
        const focusDocs = fragments.length === 0 ? [] : docs.filter((d) =>
          fragments.some((f) => String(d.title || '').toLowerCase().includes(f) || normPath(d.filePath).includes(f)))
        if (fragments.length > 0 && focusDocs.length === 0) {
          return { output: '', error: `聚焦文档未匹配到索引中的任何文档：${fragments.slice(0, 3).join('、')}` }
        }
        const focusTitles = new Set(focusDocs.map((d) => baseTitle(d.title).toLowerCase()).filter(Boolean))
        const focusPaths = new Set(focusDocs.map((d) => normPath(d.filePath)))
        const weakTitles = await weakDocTitles(context)
        const llm = await llmSuggestions(context, docs, perRepo, {
          focusTitles: [...focusTitles],
          weakTitles,
        })
        if (llm.llmError) return { output: '', error: `LLM 织网失败：${llm.llmError}` }
        const rule = await ruleSuggestions(context, docs, 12)
        const merged = prioritizeSuggestions(mergeSuggestions(llm.suggestions, rule.suggestions), focusPaths, focusTitles)
        if (merged.length === 0) {
          return { output: `已扫描 ${llm.scanned}/${llm.total} 篇文档（双重扫描），没有发现值得链接的关联。图谱很干净！` }
        }
        const toApply = merged.slice(0, applyCount).map((s) => ({ documentPath: s.documentPath, targetPath: s.targetPath }))
        const { applied, skipped, repos } = await applyLinkPairs(context, toApply)
        const focusHit = applied.filter((a) => focusPaths.has(normPath(a.documentPath)) || focusTitles.has(String(a.linkTitle).toLowerCase())).length
        const parts = []
        if (applied.length > 0) {
          const focusNote = focusDocs.length > 0 ? `，其中 ${focusHit} 条直连聚焦文档` : ''
          parts.push(`🕸️ 已自动写入 ${applied.length} 条 WikiLink（重索引 ${repos.length} 个仓库${focusNote}）：\n${applied.map((a) => `- 《${a.title}》→ [[${a.linkTitle}]]`).join('\n')}\n可到「知识图谱」页查看新增的关系网。`)
        }
        if (skipped.length > 0) {
          parts.push(`⚠️ 跳过 ${skipped.length} 条：${skipped.slice(0, 3).map((s) => `${s.path}（${s.reason}）`).join('；')}${skipped.length > 3 ? ' 等' : ''}`)
        }
        if (applied.length === 0) return { output: `本次没有写入新链接。${parts.join('；')}` }
        return { output: parts.join('\n') }
      }
    )

    context.registerAgentTool(
      {
        name: 'apply_link',
        description: '应用一条整理建议：在来源文档末尾追加"相关"小节写入 [[WikiLink]]，重索引后并验证图谱边是否生成。参数来自 suggest_relations 的结果。',
        parameters: {
          type: 'object',
          properties: {
            documentPath: { type: 'string', description: '来源文档路径' },
            targetPath: { type: 'string', description: '目标文档路径' }
          },
          required: ['documentPath', 'targetPath']
        }
      },
      async (args) => {
        const docs = (await context.getDocuments()) || []
        const doc = docs.find((d) => d.filePath === args.documentPath)
        if (!doc) return { output: '', error: `来源文档不在索引中: ${args.documentPath}` }
        const target = docs.find((d) => d.filePath === args.targetPath)
        if (!target) return { output: '', error: `目标文档不在索引中: ${args.targetPath}` }

        const linkTitle = baseTitle(target.title)
        const content = await readDoc(context, doc)
        const { content: next, alreadyLinked } = withWikiLink(content, linkTitle)
        if (!alreadyLinked) await fsp.writeFile(doc.filePath, next, 'utf-8')

        // 重索引 + 验证图谱边真实生成（路径规范化比较，避免分隔符差异误报）
        const repo = await repoOf(context, doc)
        if (repo) await context.reindexRepository(repo.id)
        const edge = await context.query(
          `SELECT COUNT(*) AS n FROM document_relations dr
           JOIN documents s ON s.id = dr.source_id
           JOIN documents t ON t.id = dr.target_id
           WHERE replace(s.file_path, '\\\\', '/') = replace(?, '\\\\', '/')
             AND replace(t.file_path, '\\\\', '/') = replace(?, '\\\\', '/')`,
          [doc.filePath, target.filePath]
        )
        const edgeCount = Array.isArray(edge) && edge[0] ? Number(edge[0].n) : 0

        if (edgeCount > 0) {
          const note = alreadyLinked ? `《${doc.title}》已有指向「${linkTitle}」的链接` : `已在《${doc.title}》添加 [[${linkTitle}]]`
          return { output: `✅ ${note}，图谱边验证通过（当前 ${edgeCount} 条边）。`, ui: { intent: 'notify', type: 'success', message: `图谱边已建立：${doc.title} → ${linkTitle}` } }
        }
        return { output: `⚠️ WikiLink${alreadyLinked ? '已存在' : '已写入'}《${doc.title}》，但重索引后未检测到到「${linkTitle}」的图谱边，请检查目标文档是否在同一仓库并已建索引。`, ui: { intent: 'notify', type: 'warning', message: '链接已写入，但图谱边验证未通过' } }
      }
    )

    context.registerAgentTool(
      {
        name: 'apply_links_bulk',
        description: '批量应用整理建议：一次性写入多条 [[WikiLink]]（每仓库只重索引一次），逐条汇报结果。适合批量导入资料后一次补全图谱；参数 links 取自 suggest_relations 结果的 {documentPath, targetPath}，上限 50 条。',
        parameters: {
          type: 'object',
          properties: {
            links: {
              type: 'array',
              description: '待应用建议列表',
              items: {
                type: 'object',
                properties: {
                  documentPath: { type: 'string', description: '来源文档路径' },
                  targetPath: { type: 'string', description: '目标文档路径' }
                },
                required: ['documentPath', 'targetPath']
              }
            }
          },
          required: ['links']
        }
      },
      async (args) => {
        const links = Array.isArray(args.links) ? args.links.slice(0, 50) : []
        if (links.length === 0) return { output: '', error: '未提供待应用建议（links 为空）' }
        const { applied, skipped, repos } = await applyLinkPairs(context, links)
        const parts = []
        if (applied.length > 0) {
          parts.push(`✅ 已写入 ${applied.length} 条 WikiLink（重索引 ${repos.length} 个仓库）：\n${applied.slice(0, 10).map((a) => `- 《${a.title}》→ [[${a.linkTitle}]]`).join('\n')}${applied.length > 10 ? `\n…（共 ${applied.length} 条）` : ''}\n可到「知识图谱」页查看新增的关系网。`)
        }
        if (skipped.length > 0) {
          parts.push(`⚠️ 跳过 ${skipped.length} 条：${skipped.slice(0, 3).map((s) => `${s.path}（${s.reason}）`).join('；')}${skipped.length > 3 ? ' 等' : ''}`)
        }
        if (applied.length === 0) return { output: `未写入任何链接。${parts.join('；')}` }
        return { output: parts.join('\n') }
      }
    )

    context.registerAgentTool(
      {
        name: 'lint_links',
        description: '图谱健康体检（零 LLM 成本）：扫描文档正文中的 [[WikiLink]]，找出指向不存在文档的死链（目标被删除/改名/标题写错）。传 fix:true 可自动清理「相关」小节内插件写入的死链行（正文手写链接永远只报告不自动改，避免误删）；清理后每仓库一次重索引。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多列出的死链条数，默认 20，上限 50' },
            fix: { type: 'boolean', description: '是否自动清理「相关」小节内的插件写入死链（默认 false 只报告）' }
          }
        }
      },
      async (args) => {
        const listCap = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
        const scan = await lintScan(context)
        if (scan.dead.length === 0) {
          return { output: `✅ 链接体检通过：已扫描 ${scan.scanned}/${scan.total} 篇文档，所有 [[WikiLink]] 都能解析到真实文档，没有死链。` }
        }
        const moreNote = scan.guardReached ? '（库内文档超过 5000 篇护栏，未覆盖部分下次体检继续）' : ''
        let fixNote = ''
        if (args.fix === true) {
          const { fixed, manual } = await lintFix(context, scan.dead)
          if (fixed.length > 0) {
            fixNote += `\n\n🧹 已自动清理 ${fixed.length} 条「相关」小节内的插件写入死链（重索引后图谱不再含这些孤边）：${fixed.slice(0, 10).map((f) => `《${f.documentTitle}》移除 [[${f.linkTitle}]]`).join('、')}${fixed.length > 10 ? ' 等' : ''}`
          }
          if (manual.length > 0) {
            fixNote += `\n\n✋ 其余 ${manual.length} 条位于正文手写区，为防误删不自动改——可让我按报告逐条修正正文。`
          }
          if (fixed.length === 0) fixNote = `\n\n本轮没有可自动清理的死链（全部位于正文手写区，插件只动自己写入的「相关」小节）。`
        } else {
          fixNote = `\n\n本工具默认只报告不自动清理。可传 fix:true 自动清理「相关」小节内插件写入的死链（正文手写链接永远只报告）；或让我按报告逐条修正正文。`
        }
        return {
          output: `🔍 发现 ${scan.dead.length} 个死链（指向不存在/已改名的文档，已扫描 ${scan.scanned}/${scan.total} 篇${moreNote}）：\n` +
            scan.dead.slice(0, listCap).map((d) => `- 《${d.documentTitle}》→ [[${d.linkTo}]]（目标不存在）`).join('\n') +
            (scan.dead.length > listCap ? `\n…（其余 ${scan.dead.length - listCap} 条见下方表格）` : '') +
            fixNote,
          ui: { intent: 'show_view', view: { title: '死链体检报告', columns: [
            { key: 'documentTitle', label: '所在文档' },
            { key: 'linkTo', label: '死链目标' }
          ], rows: scan.dead.slice(0, 50) } }
        }
      }
    )

    // ---- 自动织网守护（预算硬约束：每 1h 检查增长、≥20h 一次才消耗 LLM、新增达阈值才跑、首次仅记基线） ----
    const startAutoWeave = async () => {
      let values = {}
      try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败按声明缺省 */ }
      if (values.auto_weave_enabled === false) {
        context.log('自动织网未启用（插件配置「自动织网」可开启）')
        return
      }
      context.timers.setInterval('auto-weave', () => { void autoWeaveCheck() }, 60 * 60 * 1000)
      context.log('自动织网守护已启动（每 1h 检查一次增长，达阈值且距上次 ≥20h 才消耗 LLM）')
    }

    const autoWeaveCheck = async () => {
      try {
        let values = {}
        try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败按声明缺省 */ }
        const minNew = Math.max(1, Number(values.weave_min_new_docs) || 3)
        const applyCount = Math.min(Math.max(Number(values.weave_apply_count) || 3, 1), 20)
        const total = ((await context.getDocuments()) || []).length
        const state = (await context.storage.get('weave', 'state')) || {}
        const lastCount = Number(state.lastDocCount)
        const lastAt = Number(state.lastWeaveAt) || 0
        const saveState = async () => context.storage.set('weave', 'state', { lastDocCount: total, lastWeaveAt: Date.now() })
        if (!Number.isFinite(lastCount)) {
          await saveState() // 首次运行仅记基线，不消耗 LLM
          return
        }
        if (Date.now() - lastAt < 20 * 60 * 60 * 1000) return
        if (total - lastCount < minNew) return
        // 学习目标上下文：孤岛与薄弱文档优先（织网朝「万物互联」方向生长）
        const orphans = await orphanDocs(context)
        const orphanTitles = orphans.map((o) => baseTitle(o.title)).filter(Boolean)
        const orphanPaths = new Set(orphans.map((o) => normPath(o.filePath)))
        const orphanTitlesSet = new Set(orphanTitles.map((t) => t.toLowerCase()))
        const weakTitles = await weakDocTitles(context)
        const docs = (await context.getDocuments()) || []
        const llm = await llmSuggestions(context, docs, 20, { focusTitles: orphanTitles, weakTitles })
        await saveState()
        if (llm.llmError) {
          await context.notify.show({ title: '小诺 · 自动织网失败', body: `LLM 织网失败：${llm.llmError}` })
          return
        }
        const rule = await ruleSuggestions(context, docs, 12)
        const merged = prioritizeSuggestions(mergeSuggestions(llm.suggestions, rule.suggestions), orphanPaths, orphanTitlesSet).slice(0, applyCount)
        if (merged.length === 0) {
          await context.notify.show({ title: '小诺 · 自动织网', body: `新文档已扫描（${llm.scanned}/${llm.total} 篇），本轮没有发现值得自动链接的关联。` })
          return
        }
        const { applied, skipped } = await applyLinkPairs(context, merged.map((s) => ({ documentPath: s.documentPath, targetPath: s.targetPath })))
        await context.notify.show({
          title: '小诺 · 自动织网完成',
          body: applied.length > 0
            ? `已自动建立 ${applied.length} 条文档关联（${applied.slice(0, 2).map((a) => `《${a.title}》→${a.linkTitle}`).join('、')}${applied.length > 2 ? ' 等' : ''}），可在知识图谱查看。`
            : `扫描完成，本轮 ${skipped.length} 条建议均不适用，未做改动。`,
        })
      } catch (err) {
        context.log(`自动织网检查失败: ${(err && err.message) || err}`)
      }
    }

    await startAutoWeave()
  },

  deactivate() {
    ctx = null
    // 宿主托管定时器随停用自动清理（ADR-202），无需手动 clearInterval
  }
}
