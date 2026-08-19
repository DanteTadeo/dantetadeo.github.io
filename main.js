/* ComprimeYa — compresor de imágenes 100 % en el navegador */
(function () {
  "use strict";

  /* ---------- helpers ---------- */
  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var $$ = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };
  var escHTML = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function safe(fn, name) {
    try { fn(); } catch (e) { console.warn("[" + name + "]", e); }
  }
  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- utilidades de archivos ---------- */
  function loadScript(src) {
    return new Promise(function (ok, err) {
      if (document.querySelector('script[src="' + src + '"]')) { ok(); return; }
      var s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = function () { err(new Error(src)); };
      document.body.appendChild(s);
    });
  }

  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
    return (bytes / 1048576).toFixed(2) + " MB";
  }

  function isHeic(file) {
    return /\.heic$|\.heif$/i.test(file.name) || /heic|heif/i.test(file.type || "");
  }

  function fileNameFrom(file) {
    var base = file.name.replace(/\.[^.]+$/, "") || "imagen";
    var m = file.name.match(/\.([A-Za-z0-9]{1,5})$/);
    var ext = m ? m[1] : ((file.type || "").split("/")[1] || "jpg");
    return base + "-comprimida." + ext;
  }

  /* ---------- modos ---------- */
  var MODES = {
    whatsapp: { maxSizeMB: 1, hint: "Deja cada foto en torno a 1 MB: se ve perfecta en el móvil y se envía al instante." },
    email:    { maxSizeMB: 2, hint: "Hasta 2 MB por imagen: suficiente para adjuntarla sin que el correo la rechace." },
    max:      { maxSizeMB: 6, quality: 0.92, hint: "Solo quita el peso superfluo: el cambio de calidad es casi imperceptible." },
    custom:   { hint: "Elige el peso máximo exacto (entre 50 y 10 000 KB)." }
  };

  /* ---------- elementos ---------- */
  var tool = $("#tool");
  var dropzone = $("#dropzone");
  var fileInput = $("#file-input");
  var optionsBox = $("#tool-options");
  var modeSelect = $("#mode-select");
  var customKbField = $("#custom-kb-field");
  var customKb = $("#custom-kb");
  var modeHint = $("#mode-hint");
  var results = $("#tool-results");
  var resultList = $("#result-list");
  var btnZip = $("#btn-zip");
  var btnReset = $("#btn-reset");
  var errorBox = $("#tool-error");
  var errorMsg = $("#error-msg");
  var resultTip = $("#result-tip");

  var resultsData = [];   // { blob, name, sizeBefore, sizeAfter }
  var busy = false;
  var batchToken = 0;

  /* ---------- opciones ---------- */
  function currentMode() {
    var mode = modeSelect.value;
    var opts = {
      maxSizeMB: MODES[mode] ? MODES[mode].maxSizeMB : 1
    };
    if (mode === "custom") {
      var kb = Math.max(50, Math.min(10000, parseInt(customKb.value, 10) || 800));
      opts.maxSizeMB = kb / 1024;
    }
    if (MODES[mode] && MODES[mode].quality) opts.quality = MODES[mode].quality;
    return { mode: mode, opts: opts };
  }

  function updateModeUI() {
    var mode = modeSelect.value;
    customKbField.hidden = mode !== "custom";
    modeHint.textContent = (MODES[mode] && MODES[mode].hint) || "";
  }

  /* ---------- motor de compresión ---------- */
  var _compressor = null;
  function getCompressor() {
    if (_compressor) return Promise.resolve(_compressor);
    var libURL = new URL("lib/vendor/browser-image-compression.js", document.baseURI).href;
    return loadScript(libURL).then(function () {
      if (!window.imageCompression) throw new Error("motor no disponible");
      _compressor = window.imageCompression;
      return _compressor;
    });
  }

  function compressFile(file, onProgress) {
    return getCompressor().then(function (imageCompression) {
      var opts = currentMode().opts;
      opts.maxWidthOrHeight = 4000;
      opts.useWebWorker = !isHeic(file);
      opts.libURL = new URL("lib/vendor/browser-image-compression.js", document.baseURI).href;
      opts.onProgress = function (p) { onProgress(p); };
      return imageCompression(file, opts);
    });
  }

  /* ---------- fila de resultado ---------- */
  function buildRow(file) {
    var li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML =
      '<img class="result-item__thumb" alt="" hidden>' +
      '<div class="result-item__body">' +
        '<div class="result-item__name">' + escHTML(file.name) + "</div>" +
        '<div class="result-item__meta"><span class="result-item__before">' + formatBytes(file.size) + "</span></div>" +
      "</div>" +
      '<div class="result-item__actions">' +
        '<button type="button" class="btn btn--download" disabled>Descargar</button>' +
      "</div>" +
      '<div class="progress" role="progressbar" aria-label="Progreso" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress__bar"></div></div>' +
      '<div class="progress__pct">Comprimiendo…</div>';
    resultList.appendChild(li);
    return li;
  }

  function finishRow(li, file, out) {
    var thumb = $(".result-item__thumb", li);
    var before = $(".result-item__before", li);
    var bar = $(".progress", li);
    var pct = $(".progress__pct", li);
    var btn = $(".btn--download", li);
    var meta = $(".result-item__meta", li);

    var after = out.size;
    var pctSaved = file.size > 0 ? Math.round((1 - after / file.size) * 100) : 0;
    if (thumb) {
      thumb.hidden = false;
      thumb.src = URL.createObjectURL(out);
    }
    var savedTag = pctSaved > 0 ? '<span class="result-item__saved">−' + pctSaved + " %</span>" : "";
    meta.innerHTML = '<span class="result-item__before">' + formatBytes(file.size) +
      ' <span aria-hidden="true">→</span> ' + formatBytes(after) + "</span>" + savedTag;
    if (bar) bar.remove();
    if (pct) pct.remove();
    btn.disabled = false;
    btn.addEventListener("click", function () {
      saveBlob(out, fileNameFrom(file));
      document.dispatchEvent(new CustomEvent("cy:downloaded", { detail: { name: fileNameFrom(file) } }));
    });
  }

  function setRowProgress(li, p) {
    var bar = $(".progress__bar", li);
    var pct = $(".progress__pct", li);
    var progress = $(".progress", li);
    var pctInt = Math.round(p * 100);
    if (bar) bar.style.width = pctInt + "%";
    if (pct) pct.textContent = "Comprimiendo… " + pctInt + " %";
    if (progress) progress.setAttribute("aria-valuenow", String(pctInt));
  }

  function failRow(li, file, message) {
    var bar = $(".progress", li);
    var pct = $(".progress__pct", li);
    var btn = $(".btn--download", li);
    var body = $(".result-item__body", li);
    if (bar) bar.remove();
    if (pct) pct.remove();
    if (btn) btn.remove();
    var msg = document.createElement("div");
    msg.className = "result-item__error";
    msg.textContent = message || "No se pudo procesar esta imagen.";
    msg.style.color = "var(--danger)";
    msg.style.fontSize = ".84rem";
    msg.style.gridColumn = "1 / -1";
    body.appendChild(msg);
  }

  /* ---------- flujo principal ---------- */
  function processFiles(fileList) {
    if (busy) return;
    var token = ++batchToken;
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return (f.type || "").indexOf("image/") === 0;
    });
    if (!files.length) return;

    busy = true;
    errorBox.hidden = true;
    optionsBox.hidden = false;
    results.hidden = false;
    tool.setAttribute("data-state", "working");
    btnZip.hidden = true;
    resultTip.hidden = true;
    resultsData = [];

    var done = 0, okCount = 0;
    files.forEach(function (file) {
      if (file.size > 200 * 1048576) {
        failRow(buildRow(file), file, "Este archivo supera ~200 MB, el límite para procesarlo en el navegador.");
        done++; maybeEnd();
        return;
      }
      var li = buildRow(file);
      compressFile(file, function (p) { setRowProgress(li, p); }).then(function (out) {
        okCount++;
        if (token !== batchToken) return;
        resultsData.push({ blob: out, name: fileNameFrom(file), sizeBefore: file.size, sizeAfter: out.size });
        finishRow(li, file, out);
      }).catch(function () {
        if (token !== batchToken) return;
        failRow(li, file, "No se pudo procesar esta imagen. ¿Es un archivo de imagen válido?");
      }).then(function () {
        done++;
        if (token === batchToken) maybeEnd();
      });
    });

    function maybeEnd() {
      if (done !== files.length) return;
      busy = false;
      tool.setAttribute("data-state", okCount ? "done" : "error");
      if (!okCount) {
        errorMsg.textContent = "Ninguna imagen se pudo comprimir. Comprueba que sean archivos de imagen (JPG, PNG, WebP…).";
        errorBox.hidden = false;
        return;
      }
      if (files.length > 1) btnZip.hidden = false;
      resultTip.hidden = false;
    }
  }

  /* ---------- zip ---------- */
  function downloadZip() {
    if (!resultsData.length) return;
    btnZip.disabled = true;
    var zipURL = new URL("lib/vendor/jszip.min.js", document.baseURI).href;
    loadScript(zipURL).then(function () {
      var zip = new JSZip();
      resultsData.forEach(function (r) { zip.file(r.name, r.blob); });
      return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    }).then(function (blob) {
      var name = "imagenes-comprimidas.zip";
      saveBlob(blob, name);
      document.dispatchEvent(new CustomEvent("cy:downloaded", { detail: { name: name } }));
    }).catch(function () {
      alert("No se pudo crear el ZIP. Intenta descargar las imágenes una a una.");
    }).finally(function () {
      btnZip.disabled = false;
    });
  }

  function resetAll() {
    batchToken++;
    $$(".result-item__thumb", resultList).forEach(function (img) {
      if (img.src) URL.revokeObjectURL(img.src);
    });
    resultList.innerHTML = "";
    results.hidden = true;
    errorBox.hidden = true;
    fileInput.value = "";
    tool.setAttribute("data-state", "idle");
    resultsData = [];
    busy = false;
  }

  /* ---------- eventos de la herramienta ---------- */
  dropzone.addEventListener("click", function () { fileInput.click(); });

  fileInput.addEventListener("change", function () { processFiles(fileInput.files); });

  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("is-drag");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files) processFiles(e.dataTransfer.files);
  });

  document.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) processFiles(files);
  });

  modeSelect.addEventListener("change", updateModeUI);
  customKb.addEventListener("input", function () {
    var v = parseInt(customKb.value, 10);
    if (v && (v < 50 || v > 10000)) modeHint.textContent = "Valor entre 50 y 10 000 KB.";
    else updateModeUI();
  });
  btnZip.addEventListener("click", downloadZip);
  btnReset.addEventListener("click", resetAll);

  /* ---------- pop-up de anuncio (se abre tras descargar, solo si hay anuncio real) ---------- */
  function adActive(slot) {
    if (!slot) return false;
    if (slot.getAttribute("data-enabled") === "true") return true;
    return !!slot.querySelector("ins, iframe, script");
  }
  var popup = $("#ad-popup");
  var popupShown = false;
  document.addEventListener("cy:downloaded", function () {
    if (popupShown || !popup || typeof popup.showModal !== "function") return;
    if (!adActive($(".ad-slot--popup", popup))) return;
    popupShown = true;
    setTimeout(function () {
      if (typeof popup.showModal === "function") popup.showModal();
    }, 350);
  });
  function closePopup() {
    if (popup && typeof popup.close === "function") popup.close();
  }
  if (popup) {
    $("#ad-popup-close").addEventListener("click", closePopup);
    $("#ad-popup-done").addEventListener("click", closePopup);
    popup.addEventListener("click", function (e) {
      if (e.target === popup) closePopup();
    });
  }

  /* ---------- aviso en esquina (una vez por sesión) ---------- */
  var toast = $("#ad-toast");
  var toastShown = false;
  try { toastShown = sessionStorage.getItem("cy:toast") === "1"; } catch (_) {}
  if (toast && !toastShown && adActive($(".ad-slot--toast", toast))) {
    setTimeout(function () {
      if (reduced) return;
      toast.hidden = false;
    }, 8000);
  }
  if (toast) {
    $("#ad-toast-close").addEventListener("click", function () {
      toast.hidden = true;
      try { sessionStorage.setItem("cy:toast", "1"); } catch (_) {}
    });
  }

  /* ---------- estado expuesto para verificación ---------- */
  window.__CY__ = {
    state: function () {
      return {
        busy: busy,
        mode: currentMode().mode,
        results: resultsData.map(function (r) { return { name: r.name, sizeBefore: r.sizeBefore, sizeAfter: r.sizeAfter }; }),
        engineLoaded: !!_compressor
      };
    },
    processFiles: processFiles
  };

  safe(function () { updateModeUI(); }, "updateModeUI");
})();