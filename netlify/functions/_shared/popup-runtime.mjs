// netlify/functions/_shared/popup-runtime.mjs
//
// The popup that runs on pacificdiscovery.org. /api/popup-embed serialises
// popupRuntime() (with matchPage from popups-core.mjs) into the script that
// the GTM tag loads, and the dashboard designer runs the same code for its
// live preview, so what you design is exactly what visitors see.
//
// Everything is drawn inside a Shadow DOM, so the website's own CSS (which
// restyles blockquotes, buttons, inputs…) can't change how the popup looks.
//
// Rules for this function: it must be self-contained (no imports, no outside
// variables; matchPage comes in as a parameter so a bundler renaming it can't
// break the serialised copy) and plain ES2017, because it runs as-is in
// visitors' browsers.

export function popupRuntime(win, doc, CFG, OPTS, matchPage) {
  OPTS = OPTS || {};
  var preview = !!OPTS.preview;
  var KEY = "pdpop:";
  var active = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nl(s) { return esc(s).replace(/\n/g, "<br>"); }
  function store(id, val) {
    if (preview) return null;
    try {
      if (val === undefined) return JSON.parse(win.localStorage.getItem(KEY + id) || "null");
      win.localStorage.setItem(KEY + id, JSON.stringify(val));
    } catch (e) { /* private mode: show again next time, that's fine */ }
    return null;
  }
  function track(event, p, extra) {
    if (preview) return;
    try {
      win.dataLayer = win.dataLayer || [];
      var o = { event: event, popupId: p.id, popupName: p.name };
      for (var k in extra || {}) o[k] = extra[k];
      win.dataLayer.push(o);
    } catch (e) { /* ignore */ }
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function isMobile() { return !!(win.matchMedia && win.matchMedia("(max-width: 767px)").matches); }

  function eligible(p) {
    if (preview) return true;
    var t = today();
    if (p.starts && t < p.starts) return false;
    if (p.ends && t > p.ends) return false;
    if (p.devices === "mobile" && !isMobile()) return false;
    if (p.devices === "desktop" && isMobile()) return false;
    if (!matchPage(win.location.pathname, p.pages)) return false;
    var s = store(p.id);
    if (s && s.done) return false;
    if (s && s.until && Date.now() < s.until) return false;
    return true;
  }

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    ".ov{position:fixed;inset:0;background:rgba(18,38,44,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:18px;animation:fade .25s ease}",
    ".card{position:relative;background:#fff;color:#4a4a4a;font:15px/1.55 Poppins,system-ui,-apple-system,'Segoe UI',sans-serif;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden;display:flex;max-height:calc(100vh - 36px);animation:pop .3s cubic-bezier(.2,.8,.3,1.1)}",
    ".modal{width:min(480px,100%);flex-direction:column}",
    ".modal.side{width:min(820px,100%);flex-direction:row}",
    ".slide{position:fixed;right:20px;bottom:20px;width:min(380px,calc(100vw - 40px));flex-direction:column;z-index:2147483000;animation:rise .35s cubic-bezier(.2,.8,.3,1.1)}",
    ".bar{position:fixed;left:0;right:0;bottom:0;border-radius:16px 16px 0 0;flex-direction:row;align-items:center;z-index:2147483000;animation:rise .35s ease;max-height:none}",
    ".media{flex:none;background:#eef6f8}",
    ".media img{display:block;width:100%;height:100%;object-fit:cover}",
    ".modal .media,.slide .media{height:190px}",
    ".modal.side .media{width:42%;height:auto;position:relative}",
    ".modal.side .media img{position:absolute;inset:0}",
    ".content{flex:1;min-width:0;padding:30px 30px 24px;overflow:auto}",
    ".slide .content{padding:22px 22px 18px}",
    ".bar .content{display:flex;align-items:center;gap:22px;padding:16px 64px 16px 28px;max-width:1200px;margin:0 auto;width:100%}",
    ".eyebrow{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--accent)}",
    ".h{margin:0 0 8px;font:400 30px/1.12 'DM Serif Display',Georgia,serif;color:#2f2f2f}",
    ".slide .h{font-size:24px}",
    ".bar .h{font-size:22px;margin:0}",
    ".body{margin:0 0 18px;color:#4a4a4a}",
    ".bar .intro{flex:0 1 340px}",
    ".bar .body{margin:4px 0 0;font-size:13px}",
    "form{display:flex;flex-direction:column;gap:10px;margin:0}",
    ".bar form{flex:1;flex-direction:row;flex-wrap:wrap;align-items:flex-start}",
    ".row{display:flex;gap:10px}",
    ".row>.f{flex:1;min-width:0}",
    ".bar .row{flex:1 1 300px}",
    ".bar .f{flex:1 1 180px}",
    ".f{display:flex;flex-direction:column;gap:4px}",
    ".f label{font-size:12px;font-weight:600;color:#2f2f2f}",
    ".f label i{color:var(--accent);font-style:normal}",
    "input,select{width:100%;min-height:44px;border:1px solid #cfd7da;border-radius:10px;padding:9px 12px;font:inherit;color:#2f2f2f;background:#fff;margin:0;appearance:none;-webkit-appearance:none;box-shadow:none}",
    "select{background-image:linear-gradient(45deg,transparent 50%,#5b6166 50%),linear-gradient(135deg,#5b6166 50%,transparent 50%);background-position:calc(100% - 18px) 19px,calc(100% - 13px) 19px;background-size:5px 5px;background-repeat:no-repeat;padding-right:34px}",
    "input:focus,select:focus{outline:2px solid #55bbd2;outline-offset:0;border-color:#55bbd2}",
    ".f.bad input,.f.bad select{border-color:#c0392b}",
    ".msg{font-size:12px;color:#b03a22;min-height:0}",
    ".go{min-height:48px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:600 16px/1 Poppins,system-ui,sans-serif;padding:0 26px;cursor:pointer;box-shadow:0 8px 18px rgba(0,0,0,.14);margin-top:4px;transition:filter .15s,transform .15s}",
    ".go:hover{filter:brightness(.93)}",
    ".go:active{transform:translateY(1px)}",
    ".go:disabled{opacity:.6;cursor:wait}",
    ".bar .go{margin-top:20px;flex:none}",
    ".privacy{margin:4px 0 0;font-size:11.5px;color:#6b7176;line-height:1.45}",
    ".bar .privacy{flex-basis:100%;margin:0}",
    ".err{margin:0;font-size:13px;color:#b03a22}",
    ".x{position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;border:0;background:rgba(255,255,255,.92);color:#2f2f2f;font:400 24px/1 system-ui,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;box-shadow:0 2px 8px rgba(0,0,0,.12)}",
    ".x:hover{background:#fff}",
    ".x:focus-visible,.go:focus-visible{outline:3px solid #55bbd2;outline-offset:2px}",
    ".hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0}",
    ".done{text-align:left}",
    ".done .tick{width:46px;height:46px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px}",
    ".done a{display:inline-flex;margin-top:14px;min-height:44px;align-items:center;padding:0 22px;border-radius:999px;background:#288195;color:#fff;text-decoration:none;font-weight:600}",
    ".bar .done{display:flex;align-items:center;gap:14px}",
    ".bar .done .tick{margin:0;flex:none}",
    "@keyframes fade{from{opacity:0}to{opacity:1}}",
    "@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}",
    "@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}",
    "@media (max-width:767px){",
    ".ov{align-items:flex-end;padding:0}",
    ".modal,.modal.side{width:100%;flex-direction:column;border-radius:18px 18px 0 0;max-height:92vh}",
    ".modal.side .media{width:100%;height:150px;position:static}",
    ".modal.side .media img{position:static}",
    ".modal .media,.slide .media{height:150px}",
    ".content{padding:22px 20px 20px}",
    ".h{font-size:25px}",
    ".slide{right:10px;left:10px;bottom:10px;width:auto}",
    ".bar .content{flex-direction:column;align-items:stretch;gap:12px;padding:18px 20px}",
    ".bar .go{margin-top:0;width:100%}",
    ".row{flex-direction:column}",
    "}",
    "@media (prefers-reduced-motion:reduce){.ov,.card{animation:none}}",
  ].join("\n");

  function fieldHtml(f, i) {
    var id = "f" + i;
    var lab = '<label for="' + id + '">' + esc(f.label) + (f.required ? " <i aria-hidden=\"true\">*</i>" : "") + "</label>";
    var req = f.required ? " required aria-required=\"true\"" : "";
    var ctl;
    if (f.type === "select") {
      ctl = '<select id="' + id + '" name="' + esc(f.key) + '"' + req + '><option value="">Choose…</option>' +
        (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>"; }).join("") + "</select>";
    } else {
      ctl = '<input id="' + id + '" name="' + esc(f.key) + '" type="' + (f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text") + '"' +
        (f.autocomplete ? ' autocomplete="' + esc(f.autocomplete) + '"' : "") + req + ' maxlength="200">';
    }
    return '<div class="f" data-k="' + esc(f.key) + '">' + lab + ctl + '<span class="msg" id="' + id + 'm"></span></div>';
  }

  function formHtml(p) {
    var parts = [];
    var fs = p.fields || [];
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      var g = fs[i + 1];
      // First + last name share a row.
      if (f.key === "firstname" && g && g.key === "lastname" && p.layout !== "bar") {
        parts.push('<div class="row">' + fieldHtml(f, i) + fieldHtml(g, i + 1) + "</div>");
        i++;
      } else parts.push(fieldHtml(f, i));
    }
    return '<form novalidate>' + parts.join("") +
      '<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<button class="go" type="submit">' + esc(p.button || "Submit") + "</button>" +
      '<p class="err" role="alert" aria-live="polite"></p>' +
      (p.privacy ? '<p class="privacy">' + esc(p.privacy) + "</p>" : "") + "</form>";
  }

  function show(p) {
    if (active) return;
    var host = doc.createElement("div");
    host.setAttribute("data-pd-popup", p.id);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var layout = p.layout || "modal";
    var side = layout === "modal" && p.image && p.imagePos === "side";
    var media = p.image && p.imagePos !== "none" && layout !== "bar"
      ? '<div class="media"><img src="' + esc(p.image) + '" alt="' + esc(p.imageAlt || "") + '"></div>' : "";
    var intro = (p.eyebrow ? '<p class="eyebrow">' + esc(p.eyebrow) + "</p>" : "") +
      '<h2 class="h" id="pdp-h">' + esc(p.headline) + "</h2>" + (p.body ? '<p class="body">' + nl(p.body) + "</p>" : "");
    var content = layout === "bar"
      ? '<div class="content"><div class="intro">' + intro + "</div>" + formHtml(p) + "</div>"
      : '<div class="content">' + intro + formHtml(p) + "</div>";
    var card = '<div class="card ' + layout + (side ? " side" : "") + '" role="dialog" aria-labelledby="pdp-h"' +
      (layout === "modal" ? ' aria-modal="true"' : "") + ' style="--accent:' + esc(p.accent || "#F15B39") + '">' +
      '<button class="x" type="button" aria-label="Close">&times;</button>' + media + content + "</div>";
    root.innerHTML = "<style>" + CSS + "</style>" + (layout === "modal" ? '<div class="ov">' + card + "</div>" : card);
    (OPTS.container || doc.body).appendChild(host);
    var cardEl = root.querySelector(".card");
    var form = root.querySelector("form");
    var shownAt = Date.now();
    var lastFocus = doc.activeElement;
    var prevOverflow = doc.documentElement.style.overflow;
    if (layout === "modal" && !preview) doc.documentElement.style.overflow = "hidden";
    active = { p: p, host: host };
    track("pd_popup_view", p);

    function close(reason) {
      if (!active) return;
      active = null;
      host.remove();
      if (layout === "modal" && !preview) doc.documentElement.style.overflow = prevOverflow;
      doc.removeEventListener("keydown", onKey, true);
      if (reason !== "done") {
        var days = (p.frequency && p.frequency.hideDays) || 0;
        store(p.id, { until: Date.now() + days * 86400000 });
        track("pd_popup_close", p);
      }
      try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* ignore */ }
      if (OPTS.onClose) OPTS.onClose(reason);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close("esc"); return; }
      if (e.key === "Tab" && layout === "modal") {
        var els = Array.prototype.filter.call(root.querySelectorAll("button,input:not(.hp),select,a[href]"), function (el) { return !el.disabled && el.offsetParent !== null; });
        if (!els.length) return;
        var first = els[0], last = els[els.length - 1];
        var cur = root.activeElement || doc.activeElement;
        if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
      }
    }
    doc.addEventListener("keydown", onKey, true);
    root.querySelector(".x").addEventListener("click", function () { close("x"); });
    var ov = root.querySelector(".ov");
    if (ov) ov.addEventListener("click", function (e) { if (e.target === ov) close("backdrop"); });

    function setErr(key, msg) {
      var box = root.querySelector('.f[data-k="' + key + '"]');
      if (!box) return;
      box.classList.toggle("bad", !!msg);
      box.querySelector(".msg").textContent = msg || "";
      var ctl = box.querySelector("input,select");
      if (msg) ctl.setAttribute("aria-invalid", "true"); else ctl.removeAttribute("aria-invalid");
      ctl.setAttribute("aria-describedby", box.querySelector(".msg").id);
    }
    function done() {
      store(p.id, { done: 1 });
      var s = p.success || {};
      var html = '<div class="done"><div class="tick" aria-hidden="true">&#10003;</div><div><h2 class="h" id="pdp-h" tabindex="-1">' + esc(s.headline || "Thank you!") + "</h2>" +
        (s.body ? '<p class="body">' + nl(s.body) + "</p>" : "") +
        (s.linkText && s.linkUrl ? '<a href="' + esc(s.linkUrl) + '">' + esc(s.linkText) + "</a>" : "") + "</div></div>";
      var c = root.querySelector(".content");
      c.innerHTML = html;
      var h = root.querySelector(".done .h");
      if (h) h.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var data = {};
      var bad = false;
      (p.fields || []).forEach(function (f) {
        var el = form.elements[f.key];
        var v = el ? String(el.value || "").trim() : "";
        data[f.key] = v;
        var msg = "";
        if (f.required && !v) msg = f.label + " is required.";
        else if (v && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) msg = "Please enter a valid email address.";
        setErr(f.key, msg);
        if (msg && !bad) { bad = true; el.focus(); }
      });
      var err = root.querySelector(".err");
      err.textContent = "";
      if (bad) return;
      var btn = root.querySelector(".go");
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = "Sending…";
      function fail(msg) { btn.disabled = false; btn.textContent = label; err.textContent = msg; }
      if (preview) {
        setTimeout(function () { if (OPTS.onSubmit) OPTS.onSubmit(data); done(); }, 500);
        return;
      }
      var body = {
        popup: p.id,
        fields: data,
        website: form.elements.website ? form.elements.website.value : "",
        page: { uri: win.location.href, title: doc.title },
        t: Date.now() - shownAt,
      };
      fetch(OPTS.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j.ok) {
            track("pd_popup_submit", p, { program: data.program || "" });
            try {
              var hsq = (win._hsq = win._hsq || []);
              hsq.push(["identify", { email: data.email }]);
              hsq.push(["trackPageView"]);
            } catch (e2) { /* HubSpot tracking not on the page */ }
            done();
            return;
          }
          var errs = (res.j && res.j.errors) || {};
          Object.keys(errs).forEach(function (k) { setErr(k, errs[k]); });
          fail((res.j && res.j.error) || "Something went wrong. Please try again.");
        })
        .catch(function () { fail("We couldn’t send that. Check your connection and try again."); });
    });

    var firstInput = root.querySelector("input:not(.hp),select");
    // Phones: don't jump straight to the keyboard; focus the dialog's close button instead.
    if (layout === "modal" && firstInput && !preview && !isMobile()) setTimeout(function () { firstInput.focus(); }, 60);
    else if (!preview) cardEl.querySelector(".x").focus({ preventScroll: true });
    if (OPTS.onShow) OPTS.onShow({ close: close, root: root, host: host });
    return { close: close, root: root };
  }

  function arm(p) {
    var fired = false;
    var cleanups = [];
    function fire() {
      if (fired || active) return;
      fired = true;
      cleanups.forEach(function (c) { c(); });
      show(p);
    }
    var t = p.trigger || {};
    var any = false;
    if (t.delay > 0) {
      any = true;
      var timer = setTimeout(fire, t.delay * 1000);
      cleanups.push(function () { clearTimeout(timer); });
    }
    if (t.scroll > 0) {
      any = true;
      var onScroll = function () {
        var h = Math.max(doc.documentElement.scrollHeight - win.innerHeight, 1);
        if ((win.scrollY / h) * 100 >= t.scroll) fire();
      };
      win.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(function () { win.removeEventListener("scroll", onScroll); });
    }
    if (t.exit && !isMobile()) {
      any = true;
      var onOut = function (e) { if (!e.relatedTarget && e.clientY <= 4) fire(); };
      doc.addEventListener("mouseout", onOut);
      cleanups.push(function () { doc.removeEventListener("mouseout", onOut); });
    }
    if (!any) setTimeout(fire, 600);
  }

  if (preview) {
    return CFG && CFG[0] ? show(CFG[0]) : null;
  }
  // One popup per page view: the first eligible one, in the designer's order.
  for (var i = 0; i < (CFG || []).length; i++) {
    if (eligible(CFG[i])) { arm(CFG[i]); break; }
  }
  return null;
}

/** Plain ASCII, so the script reads the same whatever charset the page uses. */
function ascii(js) {
  return js.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The script served to the website (GTM). */
export function embedScript(matchPageFn, config, endpoint) {
  return ascii("/* Pacific Discovery popups — designed in dashboard.pacificdiscovery.org/popups */\n" +
    "(function(){if(window.__pdPopups)return;window.__pdPopups=1;" +
    "var matchPage=" + matchPageFn.toString() + ";\n" +
    "var popupRuntime=" + popupRuntime.toString() + ";\n" +
    "function go(){popupRuntime(window,document," + JSON.stringify(config).replace(/</g, "\\u003c") + "," + JSON.stringify({ endpoint }) + ",matchPage);}" +
    "if(document.body)go();else document.addEventListener('DOMContentLoaded',go);})();\n");
}

/** The same runtime as a callable, for the designer's live preview. */
export function previewScript(matchPageFn) {
  return ascii("window.PDPopupRuntime=(function(){var matchPage=" + matchPageFn.toString() + ";\nvar run=" + popupRuntime.toString() + ";\nreturn function(w,d,c,o){return run(w,d,c,o,matchPage);};})();\n");
}
