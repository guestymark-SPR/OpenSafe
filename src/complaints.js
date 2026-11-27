'use strict';
// Complaint ladder: the stages of a complaint, with each stage's time limits, from the organisations'
// own published rules (checked on the date in CHECKED; the links say where each rule came from).
// OpenSafe works out the dates; it can't know if an organisation changes its rules, so each template
// shows its sources and says to check the organisation's final response letter, which gives the next step.

const CHECKED = '2026-11-27';

// respond: how long the organisation has to reply at that stage
// within: how long you have to start that stage, counted from the previous stage's reply ('reply'),
//         from when you first knew about the problem ('aware'), or from your last contact ('lastContact')
const TEMPLATES = {
  sar: {
    name: 'Subject access request (your personal information)',
    steps: [
      { key: 'request', name: 'Your request', how: 'Ask the organisation for a copy of the personal information it holds about you.', respond: { months: 1 }, extendNote: 'They can take up to two more months if the request is complex or you\'ve made several, but must tell you within the first month and say why.' },
      { key: 'chase', name: 'Follow up, or complain to them', how: 'If a month has passed with no reply, or the reply is incomplete, write to them again. The ICO suggests email where possible.' },
      { key: 'ico', name: 'Complain to the ICO', how: 'The Information Commissioner\'s Office, with copies of your request, your follow-up and any replies.', within: { months: 3, from: 'lastContact', text: 'within 3 months of your last contact with the organisation' } }
    ],
    sources: [
      ['ICO: how long organisations have to reply', 'https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/what-should-we-consider-when-responding-to-a-request/'],
      ['ICO: if you don\'t get a response', 'https://ico.org.uk/for-the-public/getting-copies-of-your-information-subject-access-request/what-to-do-if-you-dont-get-a-response-or-youre-unhappy-with-it/'],
      ['ICO: before complaining to the ICO', 'https://ico.org.uk/make-a-complaint/what-to-expect/']
    ]
  },
  dwp: {
    name: 'DWP or the Child Maintenance Service',
    steps: [
      { key: 'org', name: 'Complain to them', how: 'Use their complaints process (phone, letter or online). Keep going until you get a final response that says you can go to the Independent Case Examiner.' },
      { key: 'ice', name: 'Independent Case Examiner (ICE)', how: 'Send ICE your complaint with their final response. ICE won\'t look at it before that final response.', within: { months: 6, from: 'reply', text: 'within 6 months of the final response' } },
      { key: 'phso', name: 'Ombudsman, through your MP', how: 'Ask your MP to refer it to the Parliamentary and Health Service Ombudsman. If the complaints process itself took a long time, the Ombudsman says it can sometimes still look at it later.', within: { months: 12, from: 'aware', text: 'normally within 12 months of when you first knew about the problem' } }
    ],
    sources: [
      ['GOV.UK: How to bring a complaint to the Independent Case Examiner', 'https://www.gov.uk/government/publications/how-to-take-a-complaint-to-the-independent-case-examiner/how-to-bring-a-complaint-to-the-independent-case-examiner'],
      ['Ombudsman: what to do before you come to us', 'https://www.ombudsman.org.uk/making-complaint/complaints-about-uk-government-services/what-do-you-come-us'],
      ['Ombudsman: when did the problem happen?', 'https://www.ombudsman.org.uk/making-complaint/information-advocates-and-representatives/helping-people-use-our-service/when-did-problem-happen']
    ]
  },
  veterans: {
    name: 'Veterans UK (Armed Forces Compensation or War Pension)',
    steps: [
      { key: 'stage1', name: 'Stage 1 complaint', how: 'Use the online complaint form (the Veterans UK helpline can help). Say what happened, when, how it affected you and what you want.', respond: { workingDays: 20 } },
      { key: 'stage2', name: 'Stage 2 complaint', how: 'Use the application form, with your Stage 1 reference, why the answer didn\'t resolve it and what you want.', within: { days: 28, from: 'reply', text: 'within 28 days of the Stage 1 response' }, respond: { workingDays: 20 } },
      { key: 'phso', name: 'Ombudsman, through your MP', how: 'Submit it to the Parliamentary and Health Service Ombudsman through your local MP\'s office. If the complaints process itself took a long time, the Ombudsman says it can sometimes still look at it later.', within: { months: 12, from: 'aware', text: 'normally within a year of when you first knew about the problem' } }
    ],
    sources: [['GOV.UK: Veterans UK complaints procedure', 'https://www.gov.uk/government/organisations/veterans-uk/about/complaints-procedure']]
  },
  govt: {
    name: 'Another UK government department or public body',
    steps: [
      { key: 'org', name: 'Complain to them', how: 'Use their complaints process to the end (some have two stages, or an independent reviewer). Their final response should say what you can do next.' },
      { key: 'phso', name: 'Ombudsman, through your MP', how: 'Ask your MP to refer it to the Parliamentary and Health Service Ombudsman. If the complaints process itself took a long time, the Ombudsman says it can sometimes still look at it later.', within: { months: 12, from: 'aware', text: 'within 12 months of when you first knew about the problem' } }
    ],
    sources: [['Ombudsman: what to do before you come to us', 'https://www.ombudsman.org.uk/making-complaint/complaints-about-uk-government-services/what-do-you-come-us']]
  },
  council: {
    name: 'A council (England)',
    steps: [
      { key: 'org', name: 'Complain to the council', how: 'Use the council\'s complaints procedure to the end. The Ombudsman says many complaints should take no longer than 16 weeks.' },
      { key: 'lgsco', name: 'Local Government and Social Care Ombudsman', how: 'Complain to the Ombudsman with the council\'s final response.', within: { months: 12, from: 'aware', text: 'usually within 12 months of when you first knew about the problem' } }
    ],
    sources: [['Local Government and Social Care Ombudsman', 'https://www.lgo.org.uk/make-a-complaint/fact-sheets/environment-and-waste/complaints-about-nuisance']]
  },
  financial: {
    name: 'A bank, insurer, pension or other financial business',
    steps: [
      { key: 'org', name: 'Complain to the business', how: 'Tell them what happened and how you want it put right. Their final response should come within 8 weeks for most complaints (some kinds have shorter limits).', respond: { weeks: 8 } },
      { key: 'fos', name: 'Financial Ombudsman Service', how: 'Send the Ombudsman your complaint and a copy of the final response. If there\'s no final response after 8 weeks, you can go to them anyway.', within: { months: 6, from: 'reply', text: 'within 6 months of the date on the final response' } }
    ],
    sources: [['Financial Ombudsman: time limits', 'https://www.financial-ombudsman.org.uk/consumers/complaints-can-help/expect/time-limits']]
  },
  energy: {
    name: 'An energy supplier',
    steps: [
      { key: 'org', name: 'Complain to the supplier', how: 'Use their complaints process. They have 8 weeks, unless they send a "deadlock letter" sooner.', respond: { weeks: 8 } },
      { key: 'eo', name: 'Energy Ombudsman', how: 'Raise the dispute with the Energy Ombudsman after 8 weeks or a deadlock letter.', within: { months: 12, from: 'reply', text: 'within 12 months of a deadlock letter' } }
    ],
    sources: [['Energy Ombudsman: our process', 'https://www.energyombudsman.org/our-process']]
  },
  telecoms: {
    name: 'A phone, mobile or broadband provider',
    steps: [
      { key: 'org', name: 'Complain to the provider', how: 'Use their complaints process. Since 8 April 2026 you can go to the ombudsman after 6 weeks, or sooner with a deadlock letter (you can ask for one).', respond: { weeks: 6 } },
      { key: 'adr', name: 'Communications Ombudsman or CISAS', how: 'Your provider belongs to one of the two schemes; their letters say which.', within: { months: 12, from: 'reply', text: 'within 12 months of a deadlock letter' } }
    ],
    sources: [['Ofcom: making a complaint and using ADR schemes', 'https://www.ofcom.org.uk/phones-and-broadband/service-quality/adr-schemes']]
  }
};

// ---- dates ----
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T12:00:00Z');
/** One (or n) calendar months on, the ICO way: the same date next month, or that month's last day if it has none. */
function addMonths(s, n) {
  const d = parse(s), day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
const weekend = (s) => { const w = parse(s).getUTCDay(); return w === 0 || w === 6; };
/** Working days (Monday to Friday; bank holidays aren't known here, so each one adds a day in practice). */
function addWorkingDays(s, n) { let d = s, k = 0; while (k < n) { d = addDays(d, 1); if (!weekend(d)) k++; } return d; }
/** A deadline that lands on a weekend moves to the Monday (the ICO's rule for subject access). */
function nextWorkingDay(s) { let d = s; while (weekend(d)) d = addDays(d, 1); return d; }
function addPeriod(s, p) {
  if (!s || !p) return '';
  if (p.months) return addMonths(s, p.months);
  if (p.weeks) return addDays(s, p.weeks * 7);
  if (p.workingDays) return addWorkingDays(s, p.workingDays);
  if (p.days) return addDays(s, p.days);
  return '';
}
const periodText = (p) => !p ? '' : p.months ? `${p.months} month${p.months === 1 ? '' : 's'}` : p.weeks ? `${p.weeks} weeks` : p.workingDays ? `${p.workingDays} working days` : `${p.days} days`;

/**
 * Where a complaint stands. c: { type, awareOn, steps: [{ startedOn, replyOn, note }], closedOn, customSteps }
 * Returns each stage with its dates, the current stage, and the dates that matter now.
 */
function status(c, today = iso(new Date())) {
  const T = TEMPLATES[c.type] || { name: 'Complaint', steps: (c.customSteps || []).map((s, i) => ({ key: 'c' + i, name: s.name, how: s.how || '', respond: s.days ? { days: s.days } : null })), sources: [] };
  const recs = c.steps || [];
  const aware = c.awareOn || (recs[0] && recs[0].startedOn) || '';
  let current = -1;
  const steps = T.steps.map((t, i) => {
    const r = recs[i] || {};
    const prev = recs[i - 1] || {};
    let dueReply = r.startedOn && t.respond ? addPeriod(r.startedOn, t.respond) : '';
    if (dueReply && c.type === 'sar') dueReply = nextWorkingDay(dueReply);
    let startBy = '';
    if (t.within) {
      const from = t.within.from === 'aware' ? aware : t.within.from === 'lastContact' ? (prev.replyOn || prev.startedOn || '') : (prev.replyOn || '');
      startBy = from ? addPeriod(from, t.within) : '';
    }
    const state = r.replyOn ? 'replied' : r.startedOn ? 'waiting' : 'todo';
    return Object.assign({}, t, { index: i, startedOn: r.startedOn || '', replyOn: r.replyOn || '', note: r.note || '', dueReply, startBy, state,
      overdue: state === 'waiting' && dueReply && dueReply < today, respondText: periodText(t.respond) });
  });
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].startedOn) { current = i; break; }
  const cur = steps[current] || null, next = steps[current + 1] || null;
  let action = '';
  if (c.closedOn) action = 'Closed';
  else if (!cur) action = `Start: ${steps[0].name}`;
  else if (cur.state === 'waiting') action = cur.dueReply ? (cur.overdue ? `No reply: it was due ${cur.dueReply}` : `Waiting for their reply, due ${cur.dueReply}`) : 'Waiting for their reply';
  else if (next) action = `Next: ${next.name}${next.startBy ? `, by ${next.startBy}` : ''}`;
  else action = 'Last stage replied';
  return { name: T.name, steps, current, next: next && !c.closedOn ? next : null, action, sources: T.sources || [], checked: CHECKED };
}

module.exports = { TEMPLATES, CHECKED, status, addMonths, addWorkingDays, addDays, nextWorkingDay, addPeriod };
