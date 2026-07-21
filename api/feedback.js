import fs from 'fs';
import path from 'path';

export const config = { supportsResponseStreaming: true };

// ─── 서버사이드 KB 캐시 ───────────────────────────────────────────────────────
let _kbCache = null;
function loadKB() {
  if (_kbCache) return _kbCache;
  try {
    const p = path.join(process.cwd(), 'knowledge', 'base.json');
    const kb = JSON.parse(fs.readFileSync(p, 'utf-8'));
    try {
      const p2 = path.join(process.cwd(), 'knowledge', 'base2.json');
      const kb2 = JSON.parse(fs.readFileSync(p2, 'utf-8'));
      if (kb2 && kb2.documents) {
        kb.documents = (kb.documents || []).concat(kb2.documents);
        kb.totalChunks = (kb.totalChunks || 0) + (kb2.totalChunks || 0);
      }
    } catch(e2) {
      console.warn('base2.json 로드 실패(무시):', e2.message);
    }
    _kbCache = kb;
    return _kbCache;
  } catch(e) {
    console.warn('base.json 로드 실패:', e.message);
    return null;
  }
}

// ─── Cosine Similarity ───────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// ─── Retrieve ────────────────────────────────────────────────────────────────
function retrieve(kb, queryVec, topK = 6) {
  if (!kb || !kb.documents) return [];
  const results = [];
  for (const doc of kb.documents) {
    for (const chunk of (doc.chunks || [])) {
      if (!chunk.embedding) continue;
      results.push({ docName: doc.name, docType: doc.type, text: chunk.text, score: cosineSim(queryVec, chunk.embedding) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─── Gemini Embed ────────────────────────────────────────────────────────────
async function embedText(text, geminiKey) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${geminiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY' }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  return data.embedding.values;
}

// ─── Notion 가이드라인 로드 (캐시 포함) ─────────────────────────────────────────
let _guidelinesCache = null;
let _guidelinesCacheTime = 0;
const GUIDELINES_TTL = 5 * 60 * 1000; // 5분

async function loadGuidelinesFromNotion(notionKey) {
  const now = Date.now();
  if (_guidelinesCache && (now - _guidelinesCacheTime) < GUIDELINES_TTL) {
    return _guidelinesCache;
  }

  try {
    const NOTION_DB_ID = process.env.NOTION_DB_ID || 'f1bf4e3893b445eda779d32ec464d4e8';

    // 1단계: DB 쿼리 — 활성화된 항목만, 순서대로
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: { property: '활성', checkbox: { equals: true } },
        sorts: [{ property: '순서', direction: 'ascending' }]
      })
    });

    if (!queryRes.ok) throw new Error(`Notion DB 쿼리 실패: ${queryRes.status}`);
    const queryData = await queryRes.json();

    // 2단계: 모든 페이지의 블록 콘텐츠를 병렬로 가져오기
    const pagesWithContent = await Promise.all(
      queryData.results.map(async (page) => {
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28'
          }
        });
        if (!blocksRes.ok) return { page, blocks: [] };
        const blocksData = await blocksRes.json();
        return { page, blocks: blocksData.results || [] };
      })
    );

    // 3단계: guidelines 형식으로 파싱
    const g = {};
    for (const { page, blocks } of pagesWithContent) {
      const props = page.properties;
      const section = props['섹션']?.select?.name || '';
      const category = props['카테고리']?.select?.name || '';
      const name = props['이름']?.title?.[0]?.plain_text || '';

      // 블록에서 텍스트 추출
      const textItems = blocks.map(block => {
        const content = block[block.type];
        if (!content?.rich_text) return '';
        return content.rich_text.map(t => t.plain_text).join('');
      }).filter(Boolean);

      switch (section) {
        case 'persona':
          g.persona = textItems.join('\n\n');
          break;
        case 'philosophy':
          g.corePhilosophy = textItems;
          break;
        case 'tone':
          g.toneGuide = textItems.join('\n');
          break;
        case 'category':
          if (!g.categoryGuidelines) g.categoryGuidelines = {};
          g.categoryGuidelines[category] = { name, rules: textItems };
          break;
        case 'freeGuide':
          g.freeGuidelines = textItems.join('\n');
          break;
        case 'doNotDo':
          g.doNotDo = textItems;
          break;
      }
    }

    _guidelinesCache = g;
    _guidelinesCacheTime = now;
    console.log('Notion 가이드라인 로드 완료:', Object.keys(g).join(', '));
    return g;
  } catch (e) {
    const cause = e.cause ? ` | cause: ${e.cause.message || JSON.stringify(e.cause)}` : '';
    console.warn('Notion guidelines load failed:', e.message + cause);
    if (_guidelinesCache) return _guidelinesCache; // 캐시된 데이터라도 반환
    return null;
  }
}

// ─── 플레이북(Q&A) 캐시 ─────────────────────────────────────────────────────
let _playbookCache = null;
let _playbookCacheTime = 0;
const PLAYBOOK_TTL = 5 * 60 * 1000;

async function loadPlaybookFromNotion(notionKey) {
  notionKey = (notionKey || '').trim();
  const now = Date.now();
  if (_playbookCache && (now - _playbookCacheTime) < PLAYBOOK_TTL) return _playbookCache;
  try {
    const PLAYBOOK_DB_ID = (process.env.PLAYBOOK_DB_ID || '3b9818e3e2c94735b9f1d1c75bf73ff2').trim();
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${PLAYBOOK_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: { property: '상태', select: { equals: '승인' } },
        page_size: 100
      })
    });
    if (!queryRes.ok) throw new Error(`플레이북 DB 쿼리 실패: ${queryRes.status}`);
    const queryData = await queryRes.json();

    const items = await Promise.all(
      (queryData.results || []).map(async (page) => {
        const q = page.properties?.['질문']?.title?.map(t => t.plain_text).join('') || '';
        const category = page.properties?.['카테고리']?.select?.name || '';
        let answer = '';
        const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
          headers: { 'Authorization': `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28' }
        });
        if (blocksRes.ok) {
          const blocksData = await blocksRes.json();
          answer = (blocksData.results || [])
            .filter(block => !block.type.startsWith('heading'))
            .map(block => {
              const content = block[block.type];
              if (!content?.rich_text) return '';
              return content.rich_text.map(t => t.plain_text).join('');
            })
            .filter(Boolean).join('\n');
        }
        return { q, category, answer };
      })
    );

    _playbookCache = items.filter(i => i.q && i.answer);
    _playbookCacheTime = now;
    console.log('플레이북 로드 완료:', _playbookCache.length + '건');
    return _playbookCache;
  } catch (e) {
    console.warn('플레이북 로드 실패:', e.message);
    return _playbookCache || [];
  }
}

// 로컬 파일 폴백
function loadGuidelinesFromFile() {
  try {
    const gPath = path.join(process.cwd(), 'knowledge', 'guidelines.json');
    return JSON.parse(fs.readFileSync(gPath, 'utf-8'));
  } catch(e) {
    console.warn('guidelines.json 로드 실패');
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: KB 상태 확인 ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const kb = loadKB();
    if (!kb) return res.status(200).json({ status: 'error', message: '지식베이스 로드 실패' });
    const total = (kb.documents || []).reduce((s, d) => s + (d.chunks || []).length, 0);
    const docCount = (kb.documents || []).length;
    let playbookCount = 0;
    if (process.env.NOTION_API_KEY) {
      playbookCount = (await loadPlaybookFromNotion(process.env.NOTION_API_KEY)).length;
    }
    return res.status(200).json({ status: 'ok', docCount, chunkCount: total, playbookCount });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  const { question, category, mode, isPublic, studentName, extraContext, creatorOptions } = req.body;

  // ─── 서버사이드 RAG 검색 ─────────────────────────────────────────────────────
  let hits = [];
  if (GEMINI_KEY && question) {
    try {
      const kb = loadKB();
      if (kb) {
        const queryVec = await embedText(question, GEMINI_KEY);
        hits = retrieve(kb, queryVec, 6);
      }
    } catch(e) {
      console.warn('RAG 검색 실패 (계속 진행):', e.message);
    }
  }

  // ── Creator 모드 ──────────────────────────────────────────────────────────────
  if (category === 'creator' && creatorOptions) {
    const { outputList, typeStr, channelData, scriptContext } = creatorOptions;
    const direction = extraContext || '';

    const creatorSystem = `당신은 커밍쏜 유튜브 채널의 콘텐츠 기획 전문 AI입니다.
커밍쏜의 실제 대본과 채널 데이터를 완전히 학습했으며, 커밍쏜의 말투, 가치관, 콘텐츠 구조를 깊이 이해합니다.
핵심: 솔직하고 직접적, 현실 기반, 숫자와 데이터 활용, 정보보다 감정과 서사 중심, 나만의 이야기 강조.`;

    const contextStr = hits.length > 0
      ? hits.map((h, i) => `[참고 ${i+1} — ${h.docName}]\n${h.text}`).join('\n\n---\n\n')
      : scriptContext;

    const creatorPrompt = `${channelData}

[실제 커밍쏜 대본 관련 내용]
${contextStr}

---
소재: ${question}
유형: ${typeStr}
${direction ? '방향: ' + direction : ''}
요청: ${outputList.join(', ')}

${outputList.includes('제목 후보 5개') ? `## 🎯 제목 후보 (5개)
채널 잘된 패턴 활용. 각 제목마다 클릭 이유 한 줄.
형식:
1. [제목]
→ [클릭 이유]
` : ''}
${outputList.includes('대본 구조') ? `## 📝 대본 구조
실제 커밍쏜 대본 구조 참고. 파트명 / 시간 / 핵심 내용 / 예시 멘트(커밍쏜 말투)
` : ''}
${outputList.includes('썸네일 아이디어') ? `## 🖼 썸네일 아이디어 (3개)
각각: 배경/분위기, 메인 텍스트, 서브 텍스트, 인물 포즈, 클릭 이유
` : ''}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: creatorSystem, messages: [{ role: 'user', content: creatorPrompt }] }),
      });
      const data = await response.json();
      if (data.error) throw new Error('Claude: ' + data.error.message);
      return res.status(200).json({ feedback: data.content[0].text, sources: hits });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 피드백 모드 ───────────────────────────────────────────────────────────────
  const NOTION_KEY = (process.env.NOTION_API_KEY || '').trim();
  let g = {};

  // Notion에서 가이드라인 로드 (실패 시 로컬 파일 폴백)
  if (NOTION_KEY) {
    g = await loadGuidelinesFromNotion(NOTION_KEY) || {};
  }
  if (!g.persona) {
    g = loadGuidelinesFromFile();
  }

  // 플레이북(승인된 Q&A) 로드
  let playbook = [];
  if (NOTION_KEY) {
    playbook = await loadPlaybookFromNotion(NOTION_KEY);
  }

  const corePhilosophy = (g.corePhilosophy || [
    '유튜브는 SNS가 아니라 비즈니스다. 채널은 브랜드고, 콘텐츠는 상품이다.',
    '나만의 라이프스타일을 콘텐츠에 전달하고, 이에 공감하는 사람들을 모아야 한다.',
    '감정을 남기는 콘텐츠를 만들어야 한다. 정보는 잊혀지지만 감정은 남는다.',
    '정보는 복제되지만, 서사는 절대 복제되지 않는다. 나만의 서사를 만들어야 한다.',
    '브랜딩은 더 덜어낼 수 없는 상태까지 걸어내야 완성된다.',
  ]).map((p, i) => `${i+1}. ${p}`).join('\n');

  const toneGuide = g.toneGuide || '직접적이고 핵심을 먼저 말합니다. 칭찬보다 구체적인 방향 제시를 우선합니다.';
  const categoryRules = category && g.categoryGuidelines?.[category]?.rules
    ? `\n[${g.categoryGuidelines[category].name} 피드백 지침]\n` + g.categoryGuidelines[category].rules.map(r => `- ${r}`).join('\n')
    : '';
  const doNotDo = (g.doNotDo || []).length > 0 ? '\n[절대 하지 말 것]\n' + g.doNotDo.map(d => `- ${d}`).join('\n') : '';
  const freeGuidelines = g.freeGuidelines ? `\n[추가 지침]\n${g.freeGuidelines}` : '';
  const personaBase = g.persona || '당신은 커밍쏜입니다. 유튜브 채널 성장과 콘텐츠 브랜딩 전문가입니다.';

  const playbookStr = playbook.length > 0
    ? '\n\n[팀 퍼메스 Q&A 플레이북]\n아래는 승인된 공식 Q&A입니다. 유사한 질문에는 이 답변의 내용과 기조를 우선 반영하세요.\n' +
      playbook.map((p, i) => `Q${i+1}. [${p.category}] ${p.q}\nA${i+1}. ${p.answer}`).join('\n\n')
    : '';

  const SYSTEM_PROMPT = `${personaBase}

[핵심 철학]
${corePhilosophy}

[말투와 스타일]
${toneGuide}${categoryRules}${freeGuidelines}${doNotDo}${playbookStr}

당신의 과거 콘텐츠, 강의, 컨설팅 자료를 참고하여 답변하세요.
${isPublic
  ? '지금 대화하는 상대는 멤버십 회원입니다. 1:1 코칭을 받는 것처럼 따뜻하지만 솔직하게 대화하세요.'
  : '디렉터가 수강생 미션을 검토하는 상황입니다. 커밍쏜의 관점으로 피드백 방향을 제시해주세요.'}`;

  const contextStr = hits.length > 0
    ? hits.map((h, i) => `[참고 ${i+1} — ${h.docName}]\n${h.text}`).join('\n\n---\n\n')
    : '(검색된 참고 자료 없음 — 핵심 철학을 바탕으로 답변)';

  const LABELS = { channel: '채널 기획', content: '콘텐츠 기획', free: '자유 질문' };
  const categoryLabel = LABELS[category] || '질문';

  let userPrompt;
  if (isPublic) {
    userPrompt = mode === 'structured'
      ? `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}\n\n---\n\n아래 형식으로 답변해주세요:\n\n[핵심 답변]\n(가장 중요한 포인트)\n\n[구체적으로 이렇게 해보세요]\n(실행 가능한 액션 2~3가지)\n\n[한마디]\n(철학이 담긴 한 문장으로 마무리)`
      : `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${contextStr}\n\n---\n\n커밍쏜이 직접 대화하듯 구어체로 답변해주세요. 질문자의 상황을 먼저 이해하고, 핵심을 짚은 뒤, 다음 스텝으로 마무리. 300~500자 내외.`;
  } else {
    userPrompt = mode === 'structured'
      ? `${studentName || '수강생'}의 [${categoryLabel}] 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}\n\n---\n\n[✅ 잘 잡고 있는 방향]\n(2가지, 이유 포함)\n\n[🔧 더 디깅이 필요한 부분]\n(2~3가지)\n\n[💡 다음 스텝]\n(실행 가능한 액션 2~3가지)`
      : `${studentName || '수강생'}의 [${categoryLabel}] 미션입니다.${extraContext ? `\n\n[디렉터 메모]\n${extraContext}` : ''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${contextStr}\n\n---\n\n커밍쏜이 직접 말해주듯 구어체로 피드백을 작성해주세요. Why와 서사를 먼저 짚고, 핵심 방향을 제시하고, 실행 가능한 다음 스텝으로 마무리. 400~600자 내외.`;
  }

  try {
    if (req.body && req.body.stream) {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, stream: true, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
      });
      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        return res.status(500).json({ error: 'Claude 스트림 실패: ' + upstream.status + ' ' + errText.slice(0, 180) });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.write('event: meta\ndata: ' + JSON.stringify({ sources: hits }) + '\n\n');
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const sseLines = sseBuf.split('\n');
        sseBuf = sseLines.pop();
        for (const sseLine of sseLines) {
          if (sseLine.indexOf('data:') !== 0) continue;
          const payload = sseLine.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
              res.write('event: delta\ndata: ' + JSON.stringify({ t: ev.delta.text }) + '\n\n');
            } else if (ev.type === 'error') {
              res.write('event: err\ndata: ' + JSON.stringify({ error: (ev.error && ev.error.message) || 'stream error' }) + '\n\n');
            }
          } catch(ignored) {}
        }
      }
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
    });
    const data = await response.json();
    if (data.error) throw new Error('Claude: ' + data.error.message);
    return res.status(200).json({ feedback: data.content[0].text, sources: hits });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
