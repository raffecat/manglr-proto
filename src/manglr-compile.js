manglr = (function(){
  "use strict";

  var manglr = 'manglr';
  var is_scope = manglr+'_s';
  var std_attr = new RegExp("^accept-charset$|^http-equiv$|^data-|^aria-");
  var prefix_re;
  var hasOwn = Object.prototype.hasOwnProperty;
  var nextSid = 1;
  var directives = {}; // registry.
  var prefixes = {};   // registry.
  var prefixes_dirty = true;
  var root_component = { id:'c0', cid:0, tags:{}, tpl:[] };
  var components = { c0:root_component }; // index.
  var comp_list = [root_component];
  var has_loaded = false;
  var bool_attr = "allowFullscreen|async|autofocus|autoplay|checked|compact|controls|declare|default|defaultChecked|defaultMuted|defaultSelected|defer|disabled|draggable|enabled|formNoValidate|hidden|indeterminate|inert|isMap|itemScope|loop|multiple|muted|noHref|noResize|noShade|noValidate|noWrap|open|pauseOnExit|readOnly|required|reversed|scoped|seamless|selected|sortable|spellcheck|translate|trueSpeed|typeMustMatch|visible";
  var bool_map = {};
  for (var k, s=bool_attr.split('|'), i=0; i<s.length; i++) { k=s[i]; bool_map[k.toLowerCase()]=k; }

  // ---- error reporting ----

  var error_msgs = [
    'manglr-bind.js must be loaded first!',                                 // 0
    'no handler registered for custom attribute "@"',                       // 1
    'error thrown in handler "@":',                                         // 2
    'no component found (in scope) for custom tag "@"',                     // 3
    'duplicate directive "@" registered:',                                  // 4
    'duplicate prefix "@" registered:',                                     // 5
    '[internal] parent component id "@" is missing from registry',          // 6
    '[internal] parent component does not have an id',                      // 7
    'component must have a "tag" attribute',                                // 8
    'duplicate component tag name "@" declared',                            // 9
    'directives (@) must be registered before DOMContentLoaded',            // 10
    'component tag name "@" hides another component with the same name',    // 11
    'handler for attribute "@" did not return an [expression]',             // 12
    'class attribute should not be bound to an expression: @',              // 13
  ];

  var con = window.console;

  function error(node, n, name, err) {
    if (con) con.log(manglr+': '+(error_msgs[n]||n).replace(/@/g,name), node, err);
  }

  // ---- directives ----

  // a safe api: requires the handler to return what it wants done,
  // in a form we can verify before encoding in the template.

  function Expr() {}
  function BindClass(name, expr) { this.name=name; this.expr=expr; }
  function IfCond(expr) { this.expr=expr; }

  // maybe pass a new VNode with [these] API methods, and close it on return.

  var api = {
    expr: function(src) { return src.split('.'); },
    text: function(src) { var tpl=[]; parse_text_tpl(src, tpl); return tpl; },
    cond: function(expr, node) { return [3, expr, [node]]; },
    unary: function(op, arg) { return [op, arg]; },
    bind_class: function (name, expr) {
      if (typeof(name) != 'string') throw new Error("bind_class: name must be a string");
      if (!(expr instanceof Expr)) throw new Error("bind_class: expr must be from api.expr()");
      return new BindClass(name, expr);
    },
    if_cond: function (cond) {
      if (!(expr instanceof Expr)) throw new Error("if_cond: expr must be from api.expr()");
      return new IfCond(expr);
    },
  };

  var ops = {
    bind_class: 5,
    bind_style: 6,
    if_route: 7,
  };

  directives['if'] = function (name, value, node) {
    console.log("IF:", name, value, node);
    // - remove the `if` attribute (implied by the handler)
    // - compile the expression in the scope of `node` [repeat creates its own scopes]
    // - wrap the node in a condition node.
    return api.if_cond(api.expr(value));
  };

  directives['if-route'] = function (name, value, node) {
    console.log("IF-ROUTE:", name, value, node);
    // - remove the `if` attribute (implied by the handler)
    // - compile the expression in the scope of `node` [repeat creates its own scopes]
    // - wrap the node in a condition node.
    var cond = api.unary(ops.if_route, api.text(value));
    return api.cond(cond, node);
  };

  // ---- prefix handlers ----

  prefixes['class-'] = function(name, value, node) {
    console.log("CLASS:", name, value, node);
    var expr = api.expr(value);
    return [ops.bind_class, name, expr];
  };

  prefixes['style-'] = function(name, value, node) {
    console.log("STYLE:", name, value, node);
    var expr = api.expr(value);
    return [ops.bind_style, name, expr];
  };

  function rebuild_prefixes() {
    // lazy rebuild after a new handler is registered.
    prefixes_dirty = false;
    var res = [];
    for (var k in prefixes) {
      if (hasOwn.call(prefixes, k)) {
        res.push('^'+k);
      }
    }
    prefix_re = new RegExp(res.join('|'))
  }

  // ---- parsing components ----

  var tpl_re = new RegExp("([^{]*){?([^}]*)}?","y");
  var norm_re = new RegExp("\\s+", "g")

  function norm_ws(text) {
    return text.replace(norm_re, " ");
  }

  function parse_text_tpl(text, tpl) {
    tpl_re.lastIndex = 0;
    var i = 0;
    for (;;) {
      var match = tpl_re.exec(text);
      if (!match || !match[0]) break; // will match ["", "", ""] at the end!
      var literal = match[1];
      var expr = match[2];
      if (literal) tpl.push(0, literal);
      if (expr) tpl.push(1, expr.split('.'));
      // tpl_re.lastIndex = match.index + match[0].length;
      if (i++ > 1000) throw "stop";
    }
  }

  function parse_children(node, c_tags) {
    // parse child nodes into their own tpl.
    var children = [];
    var child = node.firstChild;
    while (child != null) {
      parse_tpl(child, children, c_tags);
      child = child.nextSibling;
    }
    return children;
  }

  function parse_tpl(node, tpl, c_tags) {
    // parse a tpl out of the dom for spawning.
    var nodeType = node.nodeType;
    if (nodeType == 1) { // Element.
      var tag = node.nodeName.toLowerCase();
      if (tag === 'component' || tag === 'script') return; // elide from tpl.
      var attrs = node.attributes;
      var children = parse_children(node, c_tags);
      var comp = c_tags[tag]; // is it a component instance? (changes attribute encoding)
      if (comp) {
        // instance of a component.
        var raw = [];
        var binds = [];
        for (var i=0,n=attrs&&attrs.length; i<n; i++) {
          var attr = attrs[i];
          if (attr.specified) {
            var name = attr.name;
            var value = attr.value;
            // TODO: if directives cannot be applied to components,
            // how can they be used with `if` and `repeat` and `if-route` ?!
            if (~value.indexOf('{')) {
              var bound = [];
              parse_text_tpl(value, bound);
              binds.push(name, bound);
            } else {
              raw.push(name, value);
            }
          }
        }
        tpl.push(3, comp.cid, raw, binds, children); // create_component.
      } else {
        // HTML element.
        if (~tag.indexOf('-')) error(node, 3, tag); // debugging: report custom tag names if not a component.
        var binds = [];
        var num_attr = 0;
        for (var i=0,n=attrs&&attrs.length; i<n; i++) {
          var attr = attrs[i];
          if (attr.specified) {
            var name = attr.name;
            var name_lc = name.toLowerCase();
            var value = attr.value;
            // check if the attribute name matches any registered handler.
            var handler = directives[name_lc];
            if (handler) {
                var expr = handler(name, value, node);
                if (expr instanceof Array) {
                  binds.push.apply(binds, expr);
                  num_attr++;
                } else error(node, 12, name);
                continue;
            }
            // check if the attribute matches any registered prefix.
            if (~name_lc.indexOf('-')) {
              var m = name_lc.match(prefix_re);
              if (m) {
                var prefix = m[0];
                var suffix = name.substr(prefix.length);
                // custom binding handler.
                var handler = prefixes[prefix];
                var expr = handler(suffix, value, node);
                if (expr instanceof Array) {
                  binds.push.apply(binds, expr);
                  num_attr++;
                } else error(node, 12, name);
                continue;
              } else {
                // warn if the attribute is not a standard HTML attribute.
                if (!std_attr.test(name_lc)) error(node, 1, name);
              }
            }
            // TODO: also need to handle `if` and `repeat` here - wraps this node!
            // TODO: `route` custom-tag will wrap its contents in an `if` node.
            if (~value.indexOf('{')) {
              if (name_lc === 'class') {
                // TODO: cannot bind `class` directly -> parse as a text-tpl and split it.
                error(node, 13, expr);
              } else {
                var expr = [];
                parse_text_tpl(value, expr);
                if (hasOwn.call(bool_map, name)) {
                  // map the name to the correct property case.
                  binds.push(3, bool_map[name], expr); // bound boolean.
                  num_attr++;
                } else {
                  binds.push(2, name, expr); // bound text-template.
                  num_attr++;
                }
              }
            } else {
              // plain attribute value.
              if (name_lc === 'class') {
                // special case: each class must be handled individually.
                var names = value.split(/\s+/g);
                for (var c=0; c<names.length; c++) {
                  binds.push(4, names[c]); // literal class.
                  num_attr++;
                }
              } else if (hasOwn.call(bool_map, name)) {
                // map the name to the correct property case.
                binds.push(1, bool_map[name], true); // literal boolean.
                num_attr++;
              } else {
                binds.push(0, name, value); // literal text.
                num_attr++;
              }
            }
          }
        }
        tpl.push(2, tag, num_attr); // create_tag.
        tpl.push.apply(tpl, binds);
        tpl.push(children);
      }
    } else if (nodeType == 3) { // Text.
      // node.data: CharacterData, DOM level 1.
      parse_text_tpl(node.data, tpl); // create_text.
    }
  }

  function find_components(top) {
    // NB. `top` cannot be a component itself.
    var comp_nodes = top.getElementsByTagName('component');
    var found = [];
    // in-order traversal: parents are processed before their children,
    // therefore we can always find the parent component by id in `components`.
    for (var i=0,n=comp_nodes.length; i<n; i++) {
      var node = comp_nodes[i];
      // assign each component a unique id.
      var cid = nextSid++;
      var sid = 'c'+cid;
      node[is_scope] = sid;
      // index components so we can find parent components.
      var comp = { id:sid, cid:cid, tags:{}, tpl:[], node:node };
      components[sid] = comp;
      comp_list.push(comp);
      found.push(comp);
      // find the enclosing component - will already be in `components`.
      var parent = node.parentNode;
      var into = root_component; // enclosing component if none found.
      while (parent !== top) {
        if (parent.nodeName.toLowerCase() === 'component') {
          // found the enclosing component.
          var pid = parent[is_scope] || error(parent, 7, ''); // missing id on parent.
          into = pid ? (components[pid] || error(parent, 6, pid)) : null; // id not in registry.
          break;
        }
        parent = parent.parentNode;
      }
      var tag = node.getAttribute('tag') || error(node, 8, ''); // missing attribute.
      comp.tag = tag;
      if (tag && into) {
        // register the component in its parent by custom-tag name.
        var tag_set = into.tags;
        if (hasOwn.call(tag_set, tag)) error(node, 9, tag); // duplicate name.
        else tag_set[tag] = comp;
        comp.parent = into;
      }
    }
    // in-order traversal: parents are processed before their children,
    // therefore c_tags will hoist all ancestor tags as well.
    for (var i=0; i<found.length; i++) {
      var comp = found[i];
      var node = comp.node;
      comp.node = null; // GC.
      // hoist `tags` from the parent (includes `tags` from all ancestors)
      var c_tags = comp.tags; // NB. mutated! (hoisted tags are added)
      var parent = comp.parent;
      if (parent) {
        var up_tags = parent.tags;
        for (var k in up_tags) {
          if (hasOwn.call(up_tags, k)) {
            if (c_tags[k]) error(node, 11, k); // component tag shadows another component.
            else c_tags[k] = up_tags[k];
          }
        }
      }
      // parse dom nodes to create a template for spawning.
      var child = node.firstChild;
      while (child != null) {
        parse_tpl(child, comp.tpl, c_tags);
        child = child.nextSibling;
      }
      console.log("component:", comp.tag, comp.tpl);
    }
  }

  function parse_body(c_tags) {
    var body = document.body;
    // parse children of the body into a tpl.
    var tpl = parse_children(body, c_tags);
    // remove the children of body.
    var child = body.firstChild;
    while (child != null) {
      var next = child.nextSibling;
      body.removeChild(child);
      child = next;
    }
    return tpl;
  }

  function parse_document(doc) {
    // update the attribute prefix regex if register_prefix has been called.
    if (prefixes_dirty) rebuild_prefixes();
    // must find all component tags first, since they affect walk_dom.
    find_components(doc);
    // parse the document body into a template like the AoT compiler would.
    root_component.tpl = parse_body(root_component.tags);
    var payload = [];
    for (var i=0; i<comp_list.length; i++) {
      payload.push(comp_list[i].tpl);
    }
    console.log("payload:", payload);
    console.log(JSON.stringify(payload));
    return payload;
  }

  // ---- registration ----

  function register(name, handler, set, n) {
    var d = document;
    if (has_loaded) error(d, 10, name);
    else if (set[name]) error(d, n, name);
    else set[name] = handler;
  }

  // ---- manglr global ----

  return {
    compile: function (doc) {
      has_loaded = true;
      return parse_document(doc);
    },
    directive: function (name, handler) {
      register(name, handler, directives, 4);
    },
    prefix: function (name, handler) {
      register(name, handler, prefixes, 5);
      prefixes_dirty = true;
    }
  };

})();
