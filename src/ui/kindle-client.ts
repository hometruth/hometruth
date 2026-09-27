/** ES5 only: this runs in the Paperwhite 2's original WebKit browser. */
export const KINDLE_CLIENT = String.raw`
(function () {
  var board = document.getElementById('board');
  var feedback = document.getElementById('feedback');
  var messages = JSON.parse(document.body.getAttribute('data-messages'));
  var preview = document.body.getAttribute('data-preview') === '1';
  var busy = false, stale = false, timer;
  function buttons(disabled) {
    var list = board.querySelectorAll('[data-kindle-action]');
    for (var i = 0; i < list.length; i++) list[i].disabled = disabled || preview;
    document.getElementById('refresh').disabled = busy;
  }
  function layout() {
    var settings = document.getElementById('kindle-settings');
    document.body.setAttribute('data-layout', settings.getAttribute('data-layout') || 'list');
    var canvas = document.getElementById('kindle-canvas');
    if (!canvas) return;
    var width = Number(canvas.getAttribute('data-width')), height = Number(canvas.getAttribute('data-height'));
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (document.documentElement.clientHeight) viewportHeight = Math.min(viewportHeight, document.documentElement.clientHeight);
    var availableHeight = Math.max(1, viewportHeight - document.getElementById('kindle-toolbar').offsetHeight);
    var scale = Math.min(1, viewportWidth / width, availableHeight / height);
    var raster = canvas.getAttribute('data-raster') === '1';
    // Raster frames and their hit regions use explicit pixels, not old WebKit transforms.
    canvas.style.width = width * (raster ? scale : 1) + 'px'; canvas.style.height = height * (raster ? scale : 1) + 'px';
    var widgets = canvas.querySelectorAll('[data-widget]');
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      position(w, raster ? scale : 1);
      w.style.zIndex = w.getAttribute('data-layer');
      if (!raster) {
        w.style.fontSize = w.getAttribute('data-font') + 'px'; w.style.textAlign = w.getAttribute('data-align');
        w.style.borderWidth = w.getAttribute('data-border') + 'px';
      }
    }
    if (raster) {
      var controls = canvas.querySelectorAll('[data-kindle-action]');
      for (var j = 0; j < controls.length; j++) position(controls[j], scale);
    } else canvas.style.transform = canvas.style.webkitTransform = 'scale(' + scale + ')';
    document.getElementById('canvas-viewport').style.height = Math.ceil(height * scale) + 'px';
    document.getElementById('canvas-viewport').style.width = Math.ceil(width * scale) + 'px';
  }
  function position(element, scale) {
    element.style.left = Number(element.getAttribute('data-x')) * scale + 'px';
    element.style.top = Number(element.getAttribute('data-y')) * scale + 'px';
    element.style.width = Number(element.getAttribute('data-width')) * scale + 'px';
    element.style.height = Number(element.getAttribute('data-height')) * scale + 'px';
  }
  function loadFrame(container, done) {
    var picture = container.querySelector('.raster-image');
    if (!picture) { done(true); return; }
    var image = new Image(), finished = false;
    var timeout = setTimeout(function () { complete(false); }, 10000);
    function complete(ok) {
      if (finished) return;
      finished = true; clearTimeout(timeout); image.onload = image.onerror = null; done(ok);
    }
    image.onload = function () { complete(true); };
    image.onerror = function () { complete(false); };
    image.src = picture.getAttribute('src');
  }
  function refreshed(ok) {
    stale = !ok; busy = false;
    document.getElementById('stale').style.display = stale ? 'block' : 'none';
    layout(); buttons(stale); schedule();
  }
  window.onresize = layout;
  function schedule() {
    clearTimeout(timer);
    layout();
    var settings = document.getElementById('kindle-settings');
    var interval = Number(settings.getAttribute('data-refresh')) || 60;
    document.body.style.fontSize = settings.getAttribute('data-font') + 'px';
    timer = setTimeout(refresh, interval * 1000);
  }
  function request(method, url, body, done) {
    var xhr = new XMLHttpRequest(), finished = false;
    var watchdog = setTimeout(function () { complete(false); xhr.abort(); }, 15000);
    function complete(ok) {
      if (finished) return;
      finished = true; clearTimeout(watchdog);
      done(ok, xhr);
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) complete(xhr.status >= 200 && xhr.status < 300);
    };
    try {
      xhr.open(method, url, true);
      if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (error) { complete(false); }
  }
  function refresh() {
    if (busy) return;
    busy = true; clearTimeout(timer); buttons(true);
    var url = window.location.pathname + (window.location.search ? window.location.search + '&' : '?') + 'fragment=1&_=' + new Date().getTime();
    request('GET', url, null, function (ok, xhr) {
      ok = ok && xhr.getResponseHeader('X-HomeTruth-Kindle') === '1';
      if (!ok) { refreshed(false); return; }
      var next = document.createElement('div'); next.innerHTML = xhr.responseText;
      // Keep the previous image and its controls together until the new PNG has loaded.
      loadFrame(next, function (loaded) {
        if (loaded) board.innerHTML = xhr.responseText;
        refreshed(loaded);
      });
    });
  }
  board.onclick = function (event) {
    var target = (event || window.event).target || (event || window.event).srcElement;
    if (target && target.nodeType === 3) target = target.parentNode;
    while (target && target !== board && !target.getAttribute('data-kindle-action')) target = target.parentNode;
    if (!target || target === board || busy || stale || preview || target.disabled) return;
    var confirmation = target.getAttribute('data-confirmation');
    if (confirmation && !window.confirm(confirmation)) return;
    busy = true; clearTimeout(timer); buttons(true);
    feedback.textContent = messages.working;
    var label = target.getAttribute('data-result-label');
    request('POST', target.getAttribute('data-kindle-action'), JSON.stringify(confirmation ? { confirmed: true } : {}), function (ok, xhr) {
      // Group commands can succeed for only some members even with a 200 response.
      if (ok) { try { if (JSON.parse(xhr.responseText).ok === false) ok = false; } catch (error) {} }
      // Never retry a failed/ambiguous command, especially a momentary button.
      feedback.textContent = ok ? label + ': ' + messages.sent : messages.failed;
      busy = false;
      refresh();
    });
  };
  document.getElementById('refresh').onclick = refresh;
  busy = true; layout(); buttons(true); loadFrame(board, refreshed);
}());
`;
