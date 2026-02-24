import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

  const { question, category, mode, hits, isPublic, studentName, extraContext, creatorOptions } = req.body;

  // ── Creator 모드 ──
  if (category === 'creator' && creatorOptions) {
    const { outputList, typeStr, channelData, scriptContext } = creatorOptions;
    const direction = extraContext || '';

    const creatorSystem = `당신은 커밍쏜 유튜브 채널의 콘텐츠 기획 전문 AI입니다.
커밍쏜의 실제 대본 구조와 채널 데이터를 완전히 학습했습니다.

[커밍쏜 핵심 특성]
- 솔직하고 직접적, 현실 기반, 숫자/데이터 활용
- 정보보다 감정과 서사 중심, 나만의 경험 강조
- 말투: "솔직히 말하면~", "근데 사실~", "이게 진짜 문제인데~"

[반응 높은 미드폼 대본 구조 - 인터뷰 제외]

구조 A: 결과 선공개 → 과정 역추적 (163만뷰 러닝 영상 등)
  - 오프닝: 충격적 결과/변화 먼저 보여주기 (30초)
  - 배경: 왜 이걸 시작했는지 결핍/동기 (1분)
  - 과정 나열: 구체적 수치/날짜/에피소드 (4~6분)
  - 반전/위기: 예상 못한 어려움이나 깨달음 (2분)
  - 마무리: 지금 현재 + 시청자에게 전하는 메시지 (1분)

구조 B: 리스트형 정보 + 개인 서사 (70만뷰 퇴사 전 챙길 것 등)
  - 오프닝: 이 영상을 봐야 하는 이유 + 숫자 예고 (30초)
  - 내 경험 기반 도입: 이걸 왜 알게 됐는지 (1분)
  - 리스트 항목들: 각 항목마다 내 경험/실수 사례 포함 (5~7분)
  - 가장 중요한 것 강조: 1~2개로 압축 (1분)
  - 마무리: 행동 촉구 + 다음 영상 연결 (30초)

구조 C: 공감 → 진단 → 해결 (유튜브/자기계발 콘텐츠)
  - 오프닝: 시청자가 겪는 상황 정확히 묘사 (1분)
  - 문제의 진짜 원인 진단: 대부분이 모르는 것 (2분)
  - 내가 발견한 해결책/방법 (3~4분)
  - 실제 결과/데이터 (1분)
  - 마무리: 핵심 한 줄 + 댓글 유도 (30초)

구조 D: 쇼츠용 (320만뷰 연봉 공개 등)
  - 첫 1~2초: 핵심 팩트 바로 (연봉은 OOO입니다)
  - 3~20초: 구체적 수치 나열 (항목별 공개)
  - 마지막: 반전 한 마디 또는 시청자 공감 유도

[공통 원칙]
- 오프닝 15초 안에 영상을 봐야 할 이유 제시
- 추상적 표현 금지 → 구체적 숫자/날짜/상황으로
- 중간에 반드시 반전/예상 못한 포인트 하나
- 마무리는 항상 시청자에게 돌아오는 메시지로`;

    const styleGuide = (creatorOptions.styleStr || []).join(', ') || '구체적 초안 + 방향 제시';
    const inputModeStr = creatorOptions.inputModeStr || '소재';

    const creatorPrompt = `${channelData}

[참고 대본]
${scriptContext}

---
입력 방식: ${inputModeStr}
소재: ${question}
유형: ${typeStr}
${direction ? '추가 방향: ' + direction : ''}
요청 결과물: ${outputList.join(', ')}
결과물 스타일: ${styleGuide}

소재를 분석해서 위 반응 높은 구조 중 가장 적합한 것을 선택해 적용해주세요.
${styleGuide.includes('초안') ? '구체적인 멘트와 문장으로 작성해주세요.' : ''}
${styleGuide.includes('방향') ? '각 파트의 핵심 포인트와 방향을 명확히 제시해주세요.' : ''}

${outputList.includes('제목 후보 5개') ? `## 🎯 제목 후보 (5개)
채널 잘된 패턴 활용 (숫자+반전+타겟+현실). 각 제목마다 클릭 이유 한 줄.
형식:
1. [제목]
→ [클릭 이유]
` : ''}
${outputList.includes('대본 구조') ? `## 📝 대본 구조
선택한 구조 유형 명시 후 파트별로 작성.
형식: [파트명] (예상시간) — 핵심내용 / 예시 멘트(커밍쏜 말투)
` : ''}
${outputList.includes('썸네일 아이디어') ? `## 🖼 썸네일 아이디어 (3개)
각각: 배경/분위기, 메인 텍스트(크게), 서브 텍스트, 클릭 이유
` : ''}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: creatorSystem, messages: [{ role: 'user', content: creatorPrompt }] }),
      });
      const data = await response.json();
      if (data.error) throw new Error('Claude: ' + data.error.message);
      return res.status(200).json({ feedback: data.content[0].text });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // 지침 로드
  let g = {};
  try {
    const gPath = path.join(process.cwd(), 'knowledge', 'guidelines.json');
    g = JSON.parse(fs.readFileSync(gPath, 'utf-8'));
  } catch(e) { console.warn('guidelines.json 로드 실패'); }

  const corePhilosophy = (g.corePhilosophy || [
    '유튜브는 SNS가 아니라 비즈니스다. 채널은 브랜드고, 콘텐츠는 상품이다.',
    '나만의 라이프스타일을 콘텐츠에 전달하고, 이에 공감하는 사람들을 모아야 한다.',
    '감정을 남기는 콘텐츠를 만들어야 한다. 정보는 잊혀지지만 감정은 남는다.',
    '정보는 복제되지만, 서사는 절대 복제되지 않는다. 나만의 서사를 만들어야 한다.',
    '브랜딩은 더 덜어낼 수 없는 상태까지 걷어내야 완성된다.',
  ]).map((p,i) => `${i+1}. ${p}`).join('\n');

  const toneGuide = g.toneGuide || '직접적이고 핵심을 먼저 말합니다. 칭찬보다 구체적인 방향 제시를 우선합니다.';
  const categoryRules = category && g.categoryGuidelines?.[category]?.rules
    ? `\n[${g.categoryGuidelines[category].name} 피드백 지침]\n` + g.categoryGuidelines[category].rules.map(r=>`- ${r}`).join('\n')
    : '';
  const doNotDo = (g.doNotDo||[]).length > 0 ? '\n[절대 하지 말 것]\n' + g.doNotDo.map(d=>`- ${d}`).join('\n') : '';
  const freeGuidelines = g.freeGuidelines ? `\n[추가 지침]\n${g.freeGuidelines}` : '';
  const personaBase = g.persona || '당신은 커밍쏜입니다. 유튜브 채널 성장과 콘텐츠 브랜딩 전문가입니다.';

  const SYSTEM_PROMPT = `${personaBase}

[핵심 철학]
${corePhilosophy}

[말투와 스타일]
${toneGuide}${categoryRules}${freeGuidelines}${doNotDo}

당신의 과거 콘텐츠, 강의, 컨설팅 자료를 참고하여 답변하세요.
${isPublic
  ? '지금 대화하는 상대는 멤버십 회원입니다. 1:1 코칭을 받는 것처럼 따뜻하지만 솔직하게 대화하세요.'
  : '디렉터가 수강생 미션을 검토하는 상황입니다. 커밍쏜의 관점으로 피드백 방향을 제시해주세요.'}`;

  const contextStr = (hits||[]).map((h,i)=>`[참고 ${i+1} — ${h.docName}]\n${h.text}`).join('\n\n---\n\n');
  const LABELS = { channel:'채널 기획', content:'콘텐츠 기획', free:'자유 질문' };
  const categoryLabel = LABELS[category] || '질문';
  const ctx = contextStr || '(검색된 참고 자료 없음 — 핵심 철학을 바탕으로 답변)';

  let userPrompt;
  if (isPublic) {
    userPrompt = mode === 'structured'
      ? `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${ctx}\n\n---\n\n아래 형식으로 답변해주세요:\n\n[핵심 답변]\n(가장 중요한 포인트)\n\n[구체적으로 이렇게 해보세요]\n(실행 가능한 액션 2~3가지)\n\n[한마디]\n(철학이 담긴 한 문장으로 마무리)`
      : `[${categoryLabel}] 질문입니다.\n\n${question}\n\n---\n\n[참고 자료]\n${ctx}\n\n---\n\n커밍쏜이 직접 대화하듯 구어체로 답변해주세요. 질문자의 상황을 먼저 이해하고, 핵심을 짚은 뒤, 다음 스텝으로 마무리. 300~500자 내외.`;
  } else {
    userPrompt = mode === 'structured'
      ? `${studentName||'수강생'}의 [${categoryLabel}] 미션입니다.${extraContext?`\n\n[디렉터 메모]\n${extraContext}`:''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${ctx}\n\n---\n\n[✅ 잘 잡고 있는 방향]\n(2가지, 이유 포함)\n\n[🔧 더 디깅이 필요한 부분]\n(2~3가지)\n\n[💡 다음 스텝]\n(실행 가능한 액션 2~3가지)`
      : `${studentName||'수강생'}의 [${categoryLabel}] 미션입니다.${extraContext?`\n\n[디렉터 메모]\n${extraContext}`:''}\n\n[제출 내용]\n${question}\n\n---\n\n[참고 자료]\n${ctx}\n\n---\n\n커밍쏜이 직접 말해주듯 구어체로 피드백을 작성해주세요. Why와 서사를 먼저 짚고, 핵심 방향을 제시하고, 실행 가능한 다음 스텝으로 마무리. 400~600자 내외.`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
    });
    const data = await response.json();
    if (data.error) throw new Error('Claude: ' + data.error.message);
    return res.status(200).json({ feedback: data.content[0].text });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
