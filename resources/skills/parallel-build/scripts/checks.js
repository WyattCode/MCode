// Checks of your contract's measurable facts, for verify_page (assemble.py copies this file to <work>/checks.js).
// There is nothing to edit here: the facts are data, in the "expect" list of parts.json, which assemble.py puts into the
// page as window.__expect. verify_page runs this file in the page before the animation, runs the animation forward,
// then calls window.__specChecks(add) - add(part, text) records a problem against a part. Positions are in the
// page's viewBox units whatever the window size.
//
// Entries of "expect" (each needs "part", the part to blame; "text" is optional and overrides the message):
//   { "kind": "shape_near", "part": "wheels", "selector": "#L_wheels *", "size": [100, 140], "center": [300, 400], "tol": 25 }
//       some element under selector is within size (width and height each from min to max) and centred within tol of center;
//       the size is the shape's own geometry, without its stroke and whatever it is rotated by
//   { "kind": "covers", "part": "body", "point": [420, 246], "layers": "#L_body, #L_wing" }
//       the topmost thing at point belongs to one of these layers (a body that must cover a joint)
//   { "kind": "small", "part": "body", "layers": ["L_body"], "max": [450, 330] }
//       no element in these layers is bigger than max [width, height]: a runaway path would cover the scene
//   { "kind": "stable", "part": "body", "layer": "L_body", "move": 12, "scale": 0.15 }
//       over the whole animation the layer's box moves at most "move" units and changes size at most "scale" of its size
//   { "kind": "touches", "part": "pelican", "a": "#pl_footL", "b": "#bk_pedalL", "gap": 12 }
//       throughout the animation these two elements, usually from two different parts, stay within "gap" units of each other
//       (the distance between their boxes; overlapping counts as 0). A selector that finds nothing is itself a problem.
//   { "kind": "moves", "part": "bg", "layer": "L_hills" }
//       the layer's content changes while the animation runs (scenery that must scroll or turn); it is judged on the content,
//       not the box, because repeating scenery comes back to the same place every period
(function () {
  var svg = document.querySelector('svg');
  function scale() { var sb = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; return { sb: sb, k: vb.width / sb.width }; }
  function box(el) {
    var sc = scale(), r = el.getBoundingClientRect();
    return { x: (r.left - sc.sb.left) * sc.k, y: (r.top - sc.sb.top) * sc.k, w: r.width * sc.k, h: r.height * sc.k };
  }
  // An element's own size and centre in viewBox units, whatever it is rotated by. The on-screen box of a rotated shape is the box
  // of its rotated box: a spinning wheel 124 across measures up to 175, so a wheel in the right place would fail on its size.
  function shape(el) {
    if (!el.getBBox || !el.getScreenCTM) return null;
    try {
      var b = el.getBBox(), m = svg.getScreenCTM().inverse().multiply(el.getScreenCTM());
      var mx = b.x + b.width / 2, my = b.y + b.height / 2;
      return { w: b.width * Math.hypot(m.a, m.b), h: b.height * Math.hypot(m.c, m.d), cx: m.a * mx + m.c * my + m.e, cy: m.b * mx + m.d * my + m.f };
    } catch (err) { return null; }
  }
  var expect = Array.isArray(window.__expect) ? window.__expect : [];
  var samples = {}, states = {};
  function hash(text) { var h = 5381; for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return h; }
  function boxGap(p, q) {
    var dx = Math.max(p.x - (q.x + q.w), q.x - (p.x + p.w), 0), dy = Math.max(p.y - (q.y + q.h), q.y - (p.y + p.h), 0);
    return Math.hypot(dx, dy);
  }
  expect.forEach(function (e) {
    if (e.kind === 'touches') {
      // The worst moment counts: two things that meet at rest can part once the animation runs.
      e.__worst = -1; e.__missing = [];
      window.__samplers.push(function () {
        var a = document.querySelector(e.a), b = document.querySelector(e.b);
        if (!a && e.__missing.indexOf(e.a) < 0) e.__missing.push(e.a);
        if (!b && e.__missing.indexOf(e.b) < 0) e.__missing.push(e.b);
        if (a && b) e.__worst = Math.max(e.__worst, boxGap(box(a), box(b)));
      });
    } else if (e.kind === 'stable') {
      samples[e.layer] = samples[e.layer] || [];
      if (samples[e.layer].watched) return;
      samples[e.layer].watched = true;
      window.__samplers.push(function () { var el = document.getElementById(e.layer); if (el) samples[e.layer].push(box(el)); });
    } else if (e.kind === 'moves') {
      // Scenery that repeats (a road tile every 110 units) looks the same at certain positions, so its box can come back to where
      // it was; what must differ over time is the layer's markup (its own transform, its children's, their coordinates), not where its box is.
      states[e.layer] = states[e.layer] || [];
      if (states[e.layer].watched) return;
      states[e.layer].watched = true;
      window.__samplers.push(function () { var el = document.getElementById(e.layer); if (el) states[e.layer].push(hash(el.outerHTML)); });
    }
  });
  // A layer the contract names but the page does not have is a problem of its own: skipping it would pass a check that never ran.
  function gone(add, part, id) {
    if (document.getElementById(id)) return false;
    add(part, 'parts.json names layer ' + id + ', but the page has no element with that id, so this check could not run. Use the layer names in "order".');
    return true;
  }
  function span(list, f) { var v = list.map(f); return Math.max.apply(null, v) - Math.min.apply(null, v); }

  window.__specChecks = function (add) {
    expect.forEach(function (e) {
      var part = e.part || '';
      if (e.kind === 'shape_near') {
        // A box measured on screen is never exact: a 124-unit wheel measures 123.99997, which must not count as under 124.
        var slack = Math.max(1, e.size[1] * 0.02), low = e.size[0] - slack, high = e.size[1] + slack;
        var hit = [].slice.call(document.querySelectorAll(e.selector)).some(function (el) {
          var b = shape(el);
          return b && b.w >= low && b.w <= high && b.h >= low && b.h <= high && Math.hypot(b.cx - e.center[0], b.cy - e.center[1]) <= (e.tol || 25);
        });
        if (!hit) add(part, e.text || ('Nothing under ' + e.selector + ' is about ' + e.size[0] + '-' + e.size[1] + ' units across and centred within ' + (e.tol || 25) + ' of (' + e.center.join(',') + '), where the contract puts it.'));
      } else if (e.kind === 'covers') {
        var sc = scale(), el = document.elementFromPoint(sc.sb.left + e.point[0] / sc.k, sc.sb.top + e.point[1] / sc.k);
        if (!(el && el.closest && el.closest(e.layers))) add(part, e.text || ('The topmost thing at (' + e.point.join(',') + ') is not in ' + e.layers + ', but the contract says it must cover that point.'));
      } else if (e.kind === 'small') {
        (e.layers || []).forEach(function (id) {
          if (gone(add, part, id)) return;
          var layer = document.getElementById(id);
          var bad = [].slice.call(layer.querySelectorAll('path, polygon, polyline, rect, ellipse, circle')).filter(function (el) {
            if (el.closest('defs, clipPath, mask, linearGradient, radialGradient, pattern')) return false;
            var b = box(el); return b.w > e.max[0] || b.h > e.max[1];
          })[0];
          if (bad) { var b = box(bad); add(part, e.text || ('Layer ' + id + ' has a <' + bad.tagName + '> of ' + Math.round(b.w) + 'x' + Math.round(b.h) + ' units, far bigger than anything in it should be. Its path data or coordinates are probably wrong.')); }
        });
      } else if (e.kind === 'stable') {
        if (gone(add, part, e.layer)) return;
        var s = samples[e.layer] || []; if (s.length < 4) return;
        var cx = span(s, function (b) { return b.x + b.w / 2; }), cy = span(s, function (b) { return b.y + b.h / 2; });
        var w = span(s, function (b) { return b.w; }), h = span(s, function (b) { return b.h; });
        var limit = e.scale === undefined ? 0.15 : e.scale;
        if (cx > (e.move || 12) || cy > (e.move || 12) || w > limit * s[0].w || h > limit * s[0].h)
          add(part, e.text || ('Layer ' + e.layer + ' moves ' + Math.round(cx) + 'x' + Math.round(cy) + ' units and changes size by ' + Math.round(w) + 'x' + Math.round(h) + ' during the animation, more than it should. Check the units and amplitude of update_' + part + '.'));
      } else if (e.kind === 'touches') {
        var allowed = e.gap === undefined ? 12 : e.gap;
        if (e.__missing.length) add(part, e.text || ('Nothing matches ' + e.__missing.join(' or ') + ', so it cannot be checked that ' + e.a + ' stays against ' + e.b + '. Use the ids the contract names.'));
        else if (e.__worst > allowed) add(part, e.text || (e.a + ' and ' + e.b + ' must stay within ' + allowed + ' units of each other, but drift ' + Math.round(e.__worst) + ' apart during the animation. These two parts do not meet where the contract says.'));
      } else if (e.kind === 'moves') {
        if (gone(add, part, e.layer)) return;
        var m = states[e.layer] || []; if (m.length < 4) return;
        var distinct = {}; m.forEach(function (h) { distinct[h] = 1; });
        if (Object.keys(distinct).length < 3) add(part, e.text || ('Layer ' + e.layer + ' did not change while the animation ran (' + Object.keys(distinct).length + ' distinct state(s) in ' + m.length + ' samples); it is supposed to move. Check that update_' + part + ' actually sets its transforms or coordinates every frame.'));
      } else {
        add('', 'Unknown kind in parts.json expect: ' + e.kind);
      }
    });
  };
})();
