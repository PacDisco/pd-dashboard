// The permissions packet on screen: each part to read and initial, then the
// PINNED COPY of ue-apply/public/waiver-ui.mjs (used for the editor's preview).
// parent's name, relationship, a drawn signature and the declaration tick.
// Used by the application flow (parent signs on the student's device) and by
// /sign (parent signs from the emailed link).
import { partsFor, validateSignature } from './waiver-kit.mjs';
import { safeHtml, esc } from './form-kit.mjs';

export function renderWaiver(root, waiver, { under18 = true, parentName = '', onSubmit, submitLabel = 'Sign and continue', self = false } = {}) {
  const parts = partsFor(waiver, { under18 });
  // `self`: the applicant signs for themselves (teachers).
  const L = self
    ? { initials: 'Your initials for this part', name: 'Your full name' }
    : { initials: 'Parent/guardian initials for this part', name: 'Parent or guardian full name' };
  root.innerHTML = `
    <div class="wv">
      ${waiver.intro ? `<div class="wv-intro">${safeHtml(waiver.intro)}</div>` : ''}
      ${parts.map((p) => `
        <section class="wv-part" data-part="${esc(p.key)}">
          <h3>${esc(p.title)}</h3>
          <div class="wv-doc" tabindex="0" aria-label="${esc(p.title)}">${safeHtml(p.html)}</div>
          <label class="wv-initials"><span>${esc(L.initials)}</span>
            <input data-initials="${esc(p.key)}" maxlength="4" autocomplete="off" inputmode="text" aria-describedby="err_initials_${esc(p.key)}">
          </label>
          <div class="fk-error" id="err_initials_${esc(p.key)}" role="alert"></div>
        </section>`).join('')}
      <section class="wv-sign">
        <h3>Signature</h3>
        <div class="wv-row">
          <label class="wv-field"><span>${esc(L.name)}</span><input id="wvName" autocomplete="name" value="${esc(parentName)}" aria-describedby="err_parentName"><div class="fk-error" id="err_parentName" role="alert"></div></label>
          <label class="wv-field"${self ? ' hidden' : ''}><span>Relationship to the student</span><input id="wvRel" list="wvRelList" aria-describedby="err_relationship"><datalist id="wvRelList"><option>Mother</option><option>Father</option><option>Legal guardian</option></datalist><div class="fk-error" id="err_relationship" role="alert"></div></label>
        </div>
        <div class="wv-pad-wrap">
          <span class="wv-pad-label" id="wvPadLbl">Sign here with your finger, stylus or mouse</span>
          <canvas class="wv-pad" id="wvPad" aria-labelledby="wvPadLbl" role="img"></canvas>
          <button type="button" class="btn btn--ghost btn--sm" id="wvClear">Clear</button>
        </div>
        <div class="fk-error" id="err_signature" role="alert"></div>
        <label class="wv-agree"><input type="checkbox" id="wvAgree"> <span>${esc(waiver.declaration || 'I have read and agree to this permissions packet.')}</span></label>
        <div class="fk-error" id="err_agree" role="alert"></div>
        <button type="button" class="btn btn--primary btn--lg" id="wvSubmit">${esc(submitLabel)}</button>
      </section>
    </div>`;

  // ── signature pad ──
  const canvas = root.querySelector('#wvPad');
  const ctx = canvas.getContext('2d');
  let drawn = false; let drawing = false; let last = null;
  function size() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const img = drawn ? canvas.toDataURL() : null;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    if (img) { const i = new Image(); i.onload = () => ctx.drawImage(i, 0, 0, r.width, r.height); i.src = img; }
  }
  size();
  window.addEventListener('resize', size);
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pt(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pt(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; drawn = true; e.preventDefault();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
  root.querySelector('#wvClear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; });

  function signatureData() {
    if (!drawn) return '';
    // White background, scaled down — keeps the PNG small.
    const out = document.createElement('canvas');
    const w = 600; const h = Math.round(w * canvas.height / canvas.width);
    out.width = w; out.height = h;
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, w, h);
    o.drawImage(canvas, 0, 0, w, h);
    return out.toDataURL('image/png');
  }

  function read() {
    const initials = {};
    root.querySelectorAll('[data-initials]').forEach((i) => { initials[i.dataset.initials] = i.value; });
    return {
      parentName: root.querySelector('#wvName').value,
      relationship: self ? 'Self' : root.querySelector('#wvRel').value,
      initials,
      signature: signatureData(),
      agree: root.querySelector('#wvAgree').checked,
    };
  }

  function showErrors(errors = {}) {
    root.querySelectorAll('.wv .fk-error').forEach((el) => { el.textContent = ''; });
    for (const [k, msg] of Object.entries(errors)) {
      const el = root.querySelector(`#err_${k}`);
      if (el) el.textContent = msg;
    }
    const first = root.querySelector('.wv .fk-error:not(:empty)');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  root.querySelector('#wvSubmit').addEventListener('click', async (e) => {
    const input = read();
    const v = validateSignature(waiver, input, { under18, self });
    if (!v.ok) { showErrors(v.errors); return; }
    showErrors({});
    const btn = e.currentTarget;
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Signing…';
    try { await onSubmit(input, showErrors); }
    finally { btn.disabled = false; btn.textContent = label; }
  });

  /** Testing: fill name, relationship, initials, a scribbled signature and the tick. */
  function fillTest(name = 'Test Parent') {
    root.querySelector('#wvName').value = name || 'Test Parent';
    root.querySelector('#wvRel').value = self ? 'Self' : 'Mother';
    const ini = (name || 'Test Parent').split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'TP';
    root.querySelectorAll('[data-initials]').forEach((i) => { i.value = ini; });
    root.querySelector('#wvAgree').checked = true;
    const r = canvas.getBoundingClientRect();
    ctx.beginPath();
    for (let x = 0; x <= r.width * 0.7; x += 4) {
      const y = r.height / 2 + Math.sin(x / 9) * 18 + Math.cos(x / 23) * 10;
      if (x === 0) ctx.moveTo(20 + x, y); else ctx.lineTo(20 + x, y);
    }
    ctx.stroke();
    drawn = true;
  }

  return { showErrors, fillTest };
}

export const WAIVER_CSS = `
.wv-intro{background:#f9f8f2;border:1px solid #e7e3d6;border-radius:12px;padding:16px 18px;margin-bottom:18px}
.wv-intro p{margin:0 0 8px}
.wv-part{margin:0 0 22px}
.wv-part h3,.wv-sign h3{font-size:17px;margin:0 0 8px}
.wv-doc{max-height:340px;overflow:auto;border:1px solid #cfd7da;border-radius:12px;padding:14px 16px;background:#fff;font-size:14px;line-height:1.55}
.wv-doc p{margin:0 0 10px}.wv-doc ul{margin:0 0 10px;padding-left:22px}
.wv-doc:focus{outline:3px solid rgba(89,161,170,.45)}
.wv-initials{display:flex;align-items:center;gap:12px;margin-top:10px;font-weight:600;font-size:14px;flex-wrap:wrap}
.wv-initials input{width:90px;min-height:44px;border:1px solid #cfd7da;border-radius:10px;padding:8px 10px;font:inherit;font-size:16px;text-transform:uppercase;text-align:center}
.wv-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:640px){.wv-row{grid-template-columns:1fr}}
.wv-field span{display:block;font-weight:600;margin-bottom:6px;font-size:14px}
.wv-field input{width:100%;min-height:46px;border:1px solid #cfd7da;border-radius:10px;padding:10px 12px;font:inherit;font-size:16px}
.wv-pad-wrap{position:relative;margin-top:14px}
.wv-pad-label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.wv-pad{display:block;width:100%;height:170px;border:1.5px dashed #9fb4b8;border-radius:12px;background:#fff;touch-action:none;cursor:crosshair}
.wv-pad-wrap .btn{position:absolute;right:8px;bottom:8px}
.wv-agree{display:flex;gap:10px;align-items:flex-start;margin:16px 0 4px;font-size:15px;cursor:pointer}
.wv-agree input{width:20px;height:20px;margin-top:2px;accent-color:#2d6b74;flex:0 0 auto}
.wv-sign .btn--lg{margin-top:14px}
`;
