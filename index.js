'use strict'

/**
 * link-tagger 整理阶段插件
 * 规则型（零 LLM 依赖）：扫描文档内容，发现"提到了另一篇文档的标题但没链接"的情况，
 * 产出建议 → 用户确认后一键写入 [[WikiLink]] → 重索引 → 立即验证图谱边生成。
 * 产出全部为"建议"，绝不静默修改文档。
 */

const fsp = require('fs/promises')

function repoOf(context, doc) {
  const repos = context.listRepositories() || []
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

module.exports = {
  id: 'link-tagger',
  name: '关联建议官',
  version: '0.1.0',
  description: '整理阶段：扫描文档间互相提及但未链接的关系，给出建议并一键应用',

  activate(context) {
    context.registerAgentTool(
      {
        name: 'suggest_relations',
        description: '扫描知识库文档，发现"A 文档正文提到了 B 文档标题但两者没有链接"的整理缺口，产出 WikiLink 建议（show_view 表格）。整理知识库、补全图谱时使用。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多扫描的文档数，默认 20' }
          }
        }
      },
      async (args) => {
        // 按仓库分组扫描：多仓库场景下避免单仓库文档挤占全部扫描名额
        const perRepo = Math.min(Number(args.limit) || 12, 30)
        const byRepo = new Map()
        for (const d of (context.getDocuments() || [])) {
          const key = d.repoId || 'default'
          if (!byRepo.has(key)) byRepo.set(key, [])
          if (byRepo.get(key).length < perRepo) byRepo.get(key).push(d)
        }
        const docs = [...byRepo.values()].flat()
        if (docs.length < 2) return { output: '文档太少（至少 2 篇），无需整理。' }

        const suggestions = []
        for (const doc of docs) {
          const content = await readDoc(context, doc)
          if (!content) continue
          const repoDoc = repoOf(context, doc)
          for (const other of docs) {
            if (other.id === doc.id) continue
            // 同仓库约束：跨仓库无法建立图谱边，匹配必然无效
            const repoOther = repoOf(context, other)
            if (!repoDoc || !repoOther || repoDoc.id !== repoOther.id) continue
            const title = String(other.title || '').replace(/\.md$/i, '')
            if (!title || title.length < 2) continue
            // 自指保护：来源标题包含目标标题时（如《0. Java JVM 知识地图》vs《知识地图》），正文提及大概率是自指
            if (String(doc.title || '').includes(title)) continue
            if (content.includes(`[${title}]`) || content.includes(`[[${title}`)) continue // 已有链接
            const snippet = findMentions(content, title)
            if (snippet) suggestions.push({ documentTitle: doc.title || doc.filePath, documentPath: doc.filePath, linkTo: title, targetPath: other.filePath, snippet })
          }
        }

        if (suggestions.length === 0) {
          return { output: `已扫描 ${docs.length} 篇文档，没有发现"提及但未链接"的整理缺口。图谱很干净！` }
        }
        return {
          output: `发现 ${suggestions.length} 处整理缺口（提到了其他文档但未建立链接）：\n` +
            suggestions.slice(0, 10).map((s) => `- 《${s.documentTitle}》提到「${s.linkTo}」→ 建议加 [[${s.linkTo}]]`).join('\n') +
            `\n\n用 apply_link 工具逐条应用（会写入 WikiLink 并重索引验证图谱边）。`,
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
        const doc = (context.getDocuments() || []).find((d) => d.filePath === args.documentPath)
        if (!doc) return { output: '', error: `来源文档不在索引中: ${args.documentPath}` }
        const target = (context.getDocuments() || []).find((d) => d.filePath === args.targetPath)
        if (!target) return { output: '', error: `目标文档不在索引中: ${args.targetPath}` }

        const linkTitle = String(target.title || '').replace(/\.md$/i, '')
        let content = await readDoc(context, doc)
        const alreadyLinked = content.includes(`[[${linkTitle}`)

        if (!alreadyLinked) {
          const section = content.includes('## 相关')
            ? content.replace('## 相关', `## 相关\n- [[${linkTitle}]]`)
            : `${content.replace(/\s+$/, '')}\n\n## 相关\n\n- [[${linkTitle}]]\n`
          await fsp.writeFile(doc.filePath, section, 'utf-8')
        }

        // 重索引 + 验证图谱边真实生成（路径规范化比较，避免分隔符差异误报）
        const repo = repoOf(context, doc)
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
  },

  deactivate() {}
}
