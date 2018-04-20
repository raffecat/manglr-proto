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
  var root_component = { id:'c0', tags:{} };
  var components = { c0:root_component }; // index.
  var has_loaded = false;

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
  ];

  var con = window.console;

  function error(node, n, name, err) {
    if (con) con.log(manglr+': '+(error_msgs[n]||n).replace(/@/g,name), node, err);
  }

  // ---- prefix handlers ----

  prefixes['class-'] = function(){};
  prefixes['style-'] = function(){};

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
      // check if the tag has a custom handler.
      var tag = node.nodeName.toLowerCase();
      if (tag === 'component' || tag === 'script') return; // elide from tpl.
      // parse attributes.
      var attrs = node.attributes; // NB. Document does not have attributes.
      var raw = [];
      var binds = [];
      for (var i=0,n=attrs&&attrs.length; i<n; i++) {
        var attr = attrs[i];
        // compatibility: old versions of IE iterate over non-present attributes.
        if (attr.specified) {
          var name = attr.name;
          var value = attr.value;
          // TODO: directives and prefix-* will need to be applied when spawning,
          // but we must resolve them here because we don't want to match them during spawn!
          // TODO: also need to handle `if` and `repeat` here - wraps this node!
          // TODO: `route` custom-tag will wrap its contents in an `if` node.
          if (~value.indexOf('{')) {
            var bound = [];
            parse_text_tpl(value, bound);
            binds.push(name, bound);
          } else {
            raw.push(name, value);
          }
        }
      }
      var children = parse_children(node, c_tags);
      // match tag names against component tag-names in scope.
      var comp = c_tags[tag];
      if (comp) {
        console.log("matched component in tpl: "+tag);
        tpl.push(3, comp, raw, binds, children); // create_component.
      } else {
        // debugging: report custom tag names if not a component.
        if (~tag.indexOf('-')) error(node, 3, tag);
        tpl.push(2, tag, raw, binds, children); // create_tag.
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
      var sid = 'c'+(nextSid++);
      node[is_scope] = sid;
      // index components so we can find parent components.
      var comp = { id:sid, tags:{}, node:node, tpl:[] };
      components[sid] = comp;
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
    var tpl = parse_body(root_component.tags);
    console.log("BODY:", tpl);
    return tpl;
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
