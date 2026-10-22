/*
 * assets/lightbox.js — dashboard-wide photo popup.
 *
 * Included on every dashboard page. Any click on a link that points at a photo
 * opens it in a popup instead of downloading it / opening a tab. Works for
 * links rendered later by JS too (one delegated listener on the document).
 *
 * A link counts as a photo when its href path, its ?url= / ?name= params (the
 * /jotform-file proxy), its download attribute, title or link text ends in an
 * image extension. That last check covers proxies with opaque URLs, e.g. the
 * apply-form's /api/apply-forms?action=file&id=… whose link text is the name.
 *
 * Left alone (normal browser behaviour):
 *   - cmd/ctrl/shift/alt-click and middle-click (open in tab still works)
 *   - links explicitly labelled as downloads ("⬇ Download", title="Download")
 *   - links or containers marked data-no-lightbox
 *
 * Force a link into the viewer with data-lightbox.
 * Keys: ← / → previous/next photo on the page, Esc closes.
 */
(function () {
  if (window.__pdLightbox) return;
  window.__pdLightbox = true;

  var IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;
  var PROXY_PATHS = ['/.netlify/functions/jotform-file', '/api/jotform-file'];

  // ---- detection -----------------------------------------------------------
  function parse(href) {
    try { return new URL(href, location.href); } catch (e) { return null; }
  }
  function lastSeg(s) {
    s = String(s || '').split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch (e) {}
    return s.split('/').pop().trim();
  }
  function isProxy(u) {
    return u && u.origin === location.origin && PROXY_PATHS.indexOf(u.pathname) >= 0;
  }
  function imageName(a) {
    var u = parse(a.getAttribute('href'));
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    var cands = [
      lastSeg(u.pathname),
      lastSeg(u.searchParams.get('url')),
      u.searchParams.get('name'),
      a.getAttribute('download'),
      a.getAttribute('title'),
      (a.textContent || '').trim()
    ];
    for (var i = 0; i < cands.length; i++) {
      var c = (cands[i] || '').trim();
      if (c && IMG_RE.test(c)) return lastSeg(c);
    }
    return a.hasAttribute('data-lightbox') ? (lastSeg(u.pathname) || 'Photo') : null;
  }
  function looksLikeDownloadButton(a) {
    var t = ((a.textContent || '') + ' ' + (a.getAttribute('title') || '')).toLowerCase();
    return /\u2b07|\bdownload\b/.test(t) && !a.hasAttribute('data-lightbox');
  }
  function eligible(a) {
    if (!a || !a.getAttribute('href')) return false;
    if (a.closest('[data-no-lightbox]')) return false;
    if (a.closest('#pdlb')) return false;
    if (looksLikeDownloadButton(a)) return false;
    return !!imageName(a);
  }

  // View URL: strip forced-download params so the proxy serves inline.
  // Download URL: ask the proxy for an attachment with a proper filename.
  function urls(a, name) {
    var u = parse(a.getAttribute('href'));
    var view = new URL(u.href), dl = new URL(u.href);
    if (isProxy(u)) {
      view.searchParams.delete('download');
      dl.searchParams.set('download', '1');
      if (!dl.searchParams.get('name')) dl.searchParams.set('name', name);
    }
    return { view: view.href, dl: dl.href };
  }

  // ---- UI ------------------------------------------------------------------
  var css =
    '#pdlb{position:fixed;inset:0;z-index:2147483000;display:none;background:rgba(10,12,20,.92);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f3f4f6}' +
    '#pdlb.open{display:block}' +
    '#pdlb .bar{position:absolute;top:0;left:0;right:0;height:52px;display:flex;align-items:center;gap:10px;padding:0 14px;' +
      'background:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,0));z-index:2}' +
    '#pdlb .name{flex:1;min-width:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#pdlb .count{font-size:12px;color:#9ca3af;white-space:nowrap}' +
    '#pdlb .btn{background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:8px;padding:7px 12px;font-size:13px;' +
      'font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;line-height:1.2}' +
    '#pdlb .btn:hover{background:rgba(255,255,255,.22)}' +
    '#pdlb .x{font-size:22px;padding:2px 12px}' +
    '#pdlb .stage{position:absolute;inset:52px 0 0 0;overflow:auto;display:flex;align-items:center;justify-content:center}' +
    '#pdlb .stage.zoom{display:block;text-align:center}' +
    '#pdlb img{max-width:calc(100vw - 120px);max-height:calc(100vh - 80px);object-fit:contain;cursor:zoom-in;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.5);background:#fff;border-radius:4px;display:block;margin:auto}' +
    '#pdlb .stage.zoom img{max-width:none;max-height:none;cursor:zoom-out;margin:20px auto}' +
    '#pdlb .nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:46px;height:64px;border:0;border-radius:10px;' +
      'background:rgba(255,255,255,.12);color:#fff;font-size:28px;cursor:pointer}' +
    '#pdlb .nav:hover{background:rgba(255,255,255,.25)}' +
    '#pdlb .prev{left:12px}#pdlb .next{right:12px}' +
    '#pdlb .msg{text-align:center;max-width:420px;padding:24px;font-size:14px;color:#d1d5db;line-height:1.5}' +
    '#pdlb .msg .btn{display:inline-block;margin:12px 4px 0}' +
    '#pdlb .spin{width:36px;height:36px;border:3px solid rgba(255,255,255,.2);border-top-color:#a78bfa;border-radius:50%;' +
      'animation:pdlbspin .8s linear infinite}' +
    '@keyframes pdlbspin{to{transform:rotate(360deg)}}' +
    '@media (max-width:640px){#pdlb img{max-width:100vw}#pdlb .nav{width:38px;height:52px;font-size:22px}#pdlb .hide-sm{display:none}}';

  var root, stage, nameEl, countEl, dlEl, tabEl, prevEl, nextEl;
  var list = [], idx = 0, lastFocus = null;

  function build() {
    if (root) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div');
    root.id = 'pdlb';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML =
      '<div class="bar">' +
        '<div class="name"></div><div class="count"></div>' +
        '<a class="btn hide-sm" data-k="tab" target="_blank" rel="noopener">Open in tab \u2197</a>' +
        '<a class="btn" data-k="dl">\u2b07 Download</a>' +
        '<button class="btn x" data-k="close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<button class="nav prev" data-k="prev" aria-label="Previous">\u2039</button>' +
      '<button class="nav next" data-k="next" aria-label="Next">\u203a</button>' +
      '<div class="stage"></div>';
    document.body.appendChild(root);
    stage = root.querySelector('.stage');
    nameEl = root.querySelector('.name');
    countEl = root.querySelector('.count');
    dlEl = root.querySelector('[data-k=dl]');
    tabEl = root.querySelector('[data-k=tab]');
    prevEl = root.querySelector('[data-k=prev]');
    nextEl = root.querySelector('[data-k=next]');

    root.addEventListener('click', function (e) {
      var k = e.target.closest('[data-k]');
      if (k) {
        var kind = k.getAttribute('data-k');
        if (kind === 'close') { close(); }
        else if (kind === 'prev') { go(-1); }
        else if (kind === 'next') { go(1); }
        return;                                    // let dl / tab links work
      }
      if (e.target.tagName === 'IMG') { stage.classList.toggle('zoom'); return; }
      if (e.target === stage || e.target === root) close();   // backdrop
    });
  }

  function show() {
    var it = list[idx];
    stage.classList.remove('zoom');
    nameEl.textContent = it.name;
    countEl.textContent = list.length > 1 ? (idx + 1) + ' / ' + list.length : '';
    dlEl.href = it.dl;
    dlEl.setAttribute('download', it.name);
    tabEl.href = it.view;
    prevEl.style.display = nextEl.style.display = list.length > 1 ? '' : 'none';
    stage.innerHTML = '<div class="spin"></div>';

    var img = new Image();
    img.alt = it.name;
    img.onload = function () { if (list[idx] === it) { stage.innerHTML = ''; stage.appendChild(img); } };
    img.onerror = function () {
      if (list[idx] !== it) return;
      var heic = /\.(heic|heif|tiff?)$/i.test(it.name);
      stage.innerHTML = '<div class="msg">' +
        (heic ? 'This browser can\u2019t preview this photo format.'
              : 'Couldn\u2019t load this photo. Your session may have expired \u2014 reload the dashboard and try again.') +
        '<br><a class="btn" href="' + attr(it.dl) + '" download="' + attr(it.name) + '">\u2b07 Download</a>' +
        '<a class="btn" href="' + attr(it.view) + '" target="_blank" rel="noopener">Open in tab \u2197</a></div>';
    };
    img.src = it.view;

    // Warm the neighbours so arrowing through is instant.
    [idx - 1, idx + 1].forEach(function (j) {
      if (list.length > 1) { var n = list[(j + list.length) % list.length]; if (n && n !== it) new Image().src = n.view; }
    });
  }
  function attr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function go(d) { if (list.length < 2) return; idx = (idx + d + list.length) % list.length; show(); }

  function open(anchor) {
    build();
    // Gallery = every visible photo link on the page, de-duplicated by URL.
    var seen = {}; list = []; idx = 0;
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      if (a !== anchor && (a.offsetParent === null || !eligible(a))) return;
      if (a === anchor && !eligible(a)) return;
      var name = imageName(a), u = urls(a, name);
      if (seen[u.view] != null) { if (a === anchor) idx = seen[u.view]; return; }
      seen[u.view] = list.length;
      if (a === anchor) idx = list.length;
      list.push({ name: name, view: u.view, dl: u.dl });
    });
    if (!list.length) return false;
    lastFocus = document.activeElement;
    root.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    show();
    root.querySelector('[data-k=close]').focus();
    return true;
  }
  function close() {
    if (!root || !root.classList.contains('open')) return;
    root.classList.remove('open');
    stage.innerHTML = '';
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }

  // ---- wiring --------------------------------------------------------------
  // Capture phase so we run before page handlers (and can stop a page-level
  // click handler from also firing for a photo link).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!eligible(a)) return;
    if (open(a)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Window capture so Esc closes the popup without also closing the page's
  // own drawer/modal underneath it.
  window.addEventListener('keydown', function (e) {
    if (!root || !root.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowLeft') { go(-1); }
    else if (e.key === 'ArrowRight') { go(1); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  window.pdLightbox = { open: function (a) { return open(a); }, close: close };
})();
