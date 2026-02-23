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

  const { question, category, mode, hits, isPublic, studentName, extraContext } = req.body;

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
  const LABELS = { channel:'채널 콘셉트/브랜딩', content:'콘텐츠 기획', script:'대본/스크립트', thumbnail:'썸네일·제목', monetization:'수익화 전략', operation:'채널 운영', free:'자유 질문' };
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
