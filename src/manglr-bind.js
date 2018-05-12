(function(manglr, Node, Array, Object, Error){
  "use strict";

  var debug = false;
  var hasOwn = Object['prototype']['hasOwnProperty'];
  var nextSid = 1;
  var null_dep = { value:null, wait:-1 }; // dep.
  var is_text = { "boolean":1, "number":1, "string":1, "symbol":1, "undefined":0, "object":0, "function":0 };
  var sym_list; // Array: symbol strings.
  var tpl; // Array: encoded templates.
  var p = 0; // read position in tpl being spawned.

  // ---- scopes and deps ----

  function Scope(up, contents) {
    // a binding context for names lexically in scope.
    // find bound names in `b` or follow the `up` scope-chain.
    var s = { id:'s'+(nextSid++), binds:{}, up:up, contents:contents, dom:[], watch:[], inner:[] };
    if (up) up.inner['push'](s); // register to be destroyed with enclosing scope.
    return s;
  }

  function move_scope(scope, parent, after) {
  }

  function reset_scope(scope) {
    // reset [destroy] all the spawned contents in the scope.
    // NB. don't clear `binds`, `up`, `contents` because the scope can be re-populated.
    // remove the top-level DOM nodes.
    var dom = scope.dom;
    for (var i=0; i<dom['length']; i++) {
      var node = dom[i]; // Node|Scope.
      // ignore child scopes here, because they're also in `scope.inner`.
      if (node instanceof Node) {
        node['parentNode']['removeChild'](node);
      }
    }
    scope.dom['length'] = 0;
    // reset all inner [child] scopes.
    // TODO: don't need to remove dom from all inner scopes [only top-level ones!]
    var inner = scope.inner;
    for (var i=0; i<inner['length']; i++) {
      reset_scope(inner[i]);
    }
    // TODO: remove watches.
    // Important because many of them are bound to outer scopes.
  }

  function name_from_scope(scope, name) {
    // walk up the scope chain and find the name.
    // TODO: scopes don't need dynamic names -> use vectors; `up` is a prefix.
    var sid = scope.id;
    do {
      var binds = scope.binds;
      if (hasOwn['call'](binds, name)) {
        return binds[name];
      }
      scope = scope.up;
    } while (scope);
    // the name was not found in the scope chain, which is a compile-time
    // error and should not happen at run-time (even so, do not crash)
    console.log("name '"+name+"' not found in scope '"+sid+"' (compiler fault)");
    return null_dep;
  }

  // scopes always hold deps - slot or computed bound to a name.
  // deps can be const (wait<0) - such deps will never update.
  // models also always hold deps - can create on demand?

  // have const deps because we create [recursive] components at run-time,
  // also `repeat` over data that will never change (for the life of the repeat)

  function dep_upd_field(dep) {
    var model = dep.from.value;
    // TODO: if model is actually a model, its fields will be deps.
    // TODO: -> need to make this dep follow that dep and take its value here.
    // TODO: -> need to stop following the old dep if the dep has changed.
    dep.value = (model != null) ? model[dep.name] : null;
  }

  function resolve_in_scope(scope) {
    var len = tpl[p]; p += 1;
    if (debug) console.log("[e] resolve in scope: len "+len);
    if (len < 1) return null_dep; // TODO: eliminate.
    // resolve paths by creating deps that watch fields.
    var dep = name_from_scope(scope, sym_list[tpl[p]]);
    for (var i=1; i<len; i++) {
      var name = sym_list[tpl[p+i]];
      if (dep.wait<0) {
        // constant value.
        // inline version of dep_upd_field.
        var model = dep.value;
        var val = (model != null) ? model[name] : null;
        // make a const dep with the field value.
        // TODO: if model is actually a model, its fields will be deps.
        // TODO: -> can just use that dep directly.
        dep = { value:val, wait:-1 }; // dep.
      } else {
        // varying value.
        var watch = { value:null, wait:0, fwd:[], fn:dep_upd_field, from:dep, name:name }; // dep.
        dep.fwd['push'](watch);
        dep = watch;
      }
    }
    p += len;
    return dep;
  }

  function dep_upd_concat(dep) {
    // concatenate text fragments from each input dep.
    var args = dep.args;
    var text = "";
    for (var i=0; i<args['length']; i++) {
      var val = args[i].value;
      text += is_text[typeof(val)] ? val : "";
    }
    dep.value = text;
  }

  function resolve_concat(scope) {
    // create a dep that updates after all arguments have updated.
    var args = [];
    var dep = { value:"", wait:0, fwd:[], fn:dep_upd_concat, args:args }; // dep.
    var len = tpl[p++];
    if (debug) console.log("[e] concat: "+len);
    for (var i=0; i<len; i++) {
      args['push'](resolve_expr(scope));
    }
    return dep;
  }

  function dep_upd_equals(dep) {
    dep.value = (dep.left.value === dep.right.value);
  }

  function resolve_equals(scope) {
    // create a dep that updates after both arguments have updated.
    var left = resolve_expr(scope);
    var right = resolve_expr(scope);
    if (debug) console.log("[e] equals:", left, right);
    var dep = { value:"", wait:0, fwd:[], fn:dep_upd_equals, left:left, right:right }; // dep.
    return dep;
  }

  function resolve_expr(scope) {
    var dep;
    switch (tpl[p++]) {
      case 0: // const_text.
        dep = { value: sym_list[tpl[p++]], wait: -1 }; // dep.
        if (debug) console.log("[e] const text: "+dep.value);
        break;
      case 1: // const_number.
        dep = { value: tpl[p++], wait: -1 }; // dep.
        if (debug) console.log("[e] const number: "+dep.value);
        break;
      case 2: // scope_lookup.
        dep = resolve_in_scope(scope);
        break;
      case 3: // concat_text.
        dep = resolve_concat(scope);
        break;
      case 4: // equals.
        dep = resolve_equals(scope);
        break;
      default:
        // can't recover from encoding errors.
        throw new Error("bad expression op: "+tpl[p]+" at "+p);
    }
    return dep;
  }

  // ---- creating templates ----

  function is_true(val) {
    // true for non-empty collection or _text_ value.
    return val instanceof Array ? val['length'] : (val || val===0);
  }

  function last_dom_node(scope) {
    // walk backwards from `scope` following the chain of `bk` references
    // until we find a DOM Node or a Scope that contains a DOM node.
    while (scope !== null) {
      // scan the nodes captured in the scope backwards for the last child.
      var children = scope.dom;
      for (var n=children['length']-1; n>=0; n--) {
        var child = children[n];
        if (child instanceof Node) return child; // Node.
        var found = last_dom_node(child); // Scope.
        if (found) return found; // Node.
      }
      // follow the `bk` link to the previous child [Node or Scope]
      var prev = scope.bk;
      if (prev instanceof Node) return prev; // Node.
      scope = prev; // Scope.
    }
    // did not find a DOM node inside `after` or any previous sibling of `after`.
    return null;
  }

  function insert_after(parent, after, node) {
    // insert after the provided insertion point, for if/repeat updates.
    // `after` can be a DOM Node or a Scope.
    var last = (after instanceof Node) ? after : last_dom_node(after); // Scope|null -> Node|null
    parent['insertBefore'](node, last ? last['nextSibling'] : parent['firstChild']);
  }

  function create_text(doc, parent, after, scope) {
    // create a text node.
    var node = doc['createTextNode'](sym_list[tpl[p++]]);
    insert_after(parent, after, node);
    return node;
  }

  function dep_upd_text_node(dep) {
    // update a DOM Text node from an input dep's value.
    var val = dep.from.value;
    dep.node.data = is_text[typeof(val)] ? val : '';
  }

  function create_bound_text(doc, parent, after, scope) {
    // create a bound text node.
    var node = doc['createTextNode']('');
    var dep = resolve_expr(scope);
    if (dep.wait<0) {
      // constant value.
      // inline version of dep_upd_text_node.
      var val = dep.value;
      node.data = is_text[typeof(val)] ? val : '';
    } else {
      // varying value.
      var watch = { value:'', wait:0, fwd:[], fn:dep_upd_text_node, node:node, from:dep }; // dep.
      console.log("create_bound_text:", dep);
      dep.fwd['push'](watch);
    }
    insert_after(parent, after, node);
    return node;
  }

  function dep_upd_text_attr(dep) {
    // update a DOM Element attribute from an input dep's value.
    var node = dep.node;
    var name = dep.name;
    var val = dep.from.value;
    if (val == null) { // or undefined.
      node['removeAttribute'](name); // is this actually a feature we need?
    } else {
      node['setAttribute'](name, is_text[typeof(val)] ? val : '');
    }
  }

  function dep_upd_bool_attr(dep) {
    // update a DOM Element attribute from an input dep's value.
    var node = dep.node;
    var name = dep.name;
    var val = dep.from.value;
    node[name] = !! is_true(val); // cast to boolean.
  }

  function add_class(elem, cls) {
    var clist = elem.classList;
    if (clist) {
      // classList is fast and avoids spurious reflows.
      clist['add'](cls);
    } else {
      // check if the class is already present.
      var classes = elem['className']['split'](' ');
      for (var i=0; i<classes['length']; i++) {
        if (classes[i] === cls) return;
      }
      // cls was not found: add the class.
      elem['className'] = classes + ' ' + cls;
    }
  }

  function remove_class(elem, cls) {
    var clist = elem.classList;
    if (clist) {
      // classList is fast and avoids spurious reflows.
      clist['remove'](cls);
    } else {
      var classes = elem['className']['split'](' '), orig = classes;
      for (var i=0; i<classes['length']; i++) {
        if (classes[i] === cls) {
          classes = classes['replace'](cls,'');
        }
      }
      // avoid setting className unless we actually changed it.
      if (classes !== orig) elem['className'] = classes;
    }
  }

  function dep_upd_node_class(dep) {
    (is_true(dep.value) ? add_class : remove_class)(dep.node, dep.name);
  }

  function create_tag(doc, parent, after, scope) {
    var tag = sym_list[tpl[p++]];
    var nattrs = tpl[p++];
    if (debug) console.log("createElement: "+tag);
    var node = doc['createElement'](tag);
    var cls = [];
    // apply attributes and bindings.
    // these are sorted (grouped) by type in the compiler.
    while (nattrs--) {
      switch (tpl[p]) {
        case 0:
          // literal text attribute.
          if (debug) console.log("[a] literal text: "+sym_list[tpl[p+1]]+" = "+sym_list[tpl[p+2]]);
          node['setAttribute'](sym_list[tpl[p+1]], sym_list[tpl[p+2]]);
          p += 3;
          break;
        case 1:
          // literal boolean attribute.
          if (debug) console.log("[a] set boolean: "+sym_list[tpl[p+1]]+" = "+sym_list[tpl[p+2]]);
          node[sym_list[tpl[p+1]]] = !! tpl[p+2]; // cast to bool.
          p += 3;
          break;
        case 2:
          // bound text attribute.
          var name = sym_list[tpl[p+1]];
          if (debug) console.log("[a] bound text: "+sym_list[tpl[p+1]]);
          p += 2;
          var dep = resolve_expr(scope);
          if (dep.wait<0) {
            // constant value.
            var val = dep.value;
            if (val != null) { // or undefined.
              node['setAttribute'](name, is_text[typeof(val)] ? val : '');
            }
          } else {
            // varying value.
            var watch = { value:null, wait:0, fwd:[], fn:dep_upd_text_attr, node:node, from:dep, name:name }; // dep.
            dep.fwd['push'](watch);
          }
          break;
        case 3:
          // bound boolean attribute.
          var name = sym_list[tpl[p+1]];
          if (debug) console.log("[a] bound boolean: "+sym_list[tpl[p+1]]);
          p += 2;
          var dep = resolve_expr(scope);
          if (dep.wait<0) {
            // constant value.
            node[name] = !! is_true(dep.value); // cast to bool.
          } else {
            // varying value.
            var watch = { value:null, wait:0, fwd:[], fn:dep_upd_bool_attr, node:node, from:dep, name:name }; // dep.
            dep.fwd['push'](watch);
          }
          break;
        case 4:
          // literal class.
          if (debug) console.log("[a] literal class: "+sym_list[tpl[p+1]]);
          cls['push'](sym_list[tpl[p+1]]);
          p += 2;
          break;
        case 5:
          // bound class (toggle)
          var name = sym_list[tpl[p+1]];
          p += 2;
          var dep = resolve_expr(scope);
          if (debug) console.log("[a] bound class:", name, dep);
          if (dep.wait<0) {
            // constant value.
            if (is_true(dep.value)) cls['push'](name);
          } else {
            // varying value.
            var watch = { value:null, wait:0, fwd:[], fn:dep_upd_node_class, node:node, from:dep, name:name }; // dep.
            dep.fwd['push'](watch);
          }
          break;
        default:
          // can't recover from encoding errors.
          throw new Error("bad attribute binding op: "+tpl[p]+" at "+p);
      }
    }
    if (cls['length']) node['className'] += cls.join(' ');
    // - htmlFor
    // - style
    insert_after(parent, after, node);
    // passing null `after` because we use our own DOM node as `parent`,
    // so there is never a _previous sibling_ DOM node for our contents.
    if (debug) console.log("spawn children...");
    spawn_nodes(doc, node, null, scope, null); // also null `capture`.
    return node;
  }

  function create_component(doc, parent, after, scope) {
    var tpl_id = tpl[p];
    var nbinds = tpl[p+1];
    p += 2;
    if (debug) console.log("create component:", tpl_id, nbinds);
    // component has its own scope because it has its own namespace for bound names,
    // but doesn't have an independent lifetime (destroyed with the parent scope)
    var com_scope = Scope(scope, null);
    for (var i=0; i<nbinds; i++) {
      var name = sym_list[tpl[p++]]; // TODO: flatten scopes into vectors (i.e. remove names)
      var dep = resolve_expr(scope);
      if (debug) console.log("bind to component:", name, dep);
      com_scope.binds[name] = dep;
    }
    // pass through `parent` and `after` so the component tpl will be created inline,
    // as if the component were replaced with its contents.
    // FIXME: means every component instance will have [2, 0] at the end for empty contents.
    if (debug) console.log("inline contents: size "+tpl[p]+" length "+tpl[p+1]);
    var size_of_tpl = tpl[p];
    com_scope.contents = p + 1; // inline `contents` tpl is at p + 1.
    spawn_tpl(doc, parent, after, tpl_id, com_scope, com_scope.dom);
    p += size_of_tpl; // skip over the inline tpl.
    // Must return a Scope to act as `after` for a subsequent Scope node.
    // The scope `dom` must contain all top-level DOM Nodes and Scopes in the tpl.
    return com_scope;
  }

  function dep_upd_condition(dep) {
    // create or destroy the `contents` based on boolean `value`.
    if (is_true(dep.value)) {
      if (!dep.present) {
        dep.present = true;
        // spawn all dom nodes, bind watches to deps in the scope.
        // pass through `parent` and `after` so the contents will be created inline.
        spawn_tpl(document, dep.parent, dep.after, dep.body_tpl, dep.inner, dep.inner.dom);
      }
    } else {
      if (dep.present) {
        dep.present = false;
        // remove all [top-level] dom nodes and unbind all watches.
        // NB. need a list: watches can be bound to parent scopes!
        reset_scope(dep.inner);
      }
    }
  }

  function create_condition(doc, parent, after, scope) {
    // Creates a scope (v-dom) representing the contents of the condition node.
    // The scope toggles between active (has dom nodes) and inactive (empty).
    // TODO: must bind all locally defined names in the scope up-front.
    var body_tpl = tpl[p++];
    var dep = resolve_expr(scope);
    var cond_scope = Scope(scope, scope.contents); // component `contents` available within `if` nodes.
    if (dep.wait<0) {
      // constant value.
      if (is_true(dep.value)) {
        // spawn the contents into the inner scope.
        spawn_tpl(doc, parent, after, body_tpl, cond_scope, cond_scope.dom);
      }
    } else {
      // varying value.
      var watch = { value:null, wait:0, fwd:[], fn:dep_upd_condition, parent:parent, after:after, body_tpl:body_tpl, scope:cond_scope, present:false }; // dep.
      dep.fwd['push'](watch);
    }
    // Must return a Scope to act as `after` for a subsequent Scope node.
    return cond_scope;
  }

  function dep_upd_repeat(dep) {
    var doc = document;
    var seq = dep.value instanceof Array ? dep.value : [];
    var parent = dep.parent;
    var after = dep.after; // start at `after` so our body_tpl will follow its DOM nodes.
    var body_tpl = dep.body_tpl;
    var bind_as = dep.bind_as;
    var rep_scope = dep.scope;
    var has = dep.has;
    var used = {};
    rep_scope.dom['length'] = 0; // must rebuild for `insert_after` in following nodes.
    rep_scope.inner['length'] = 0; // must rebuild the list of inner scopes.
    for (var i=0; i<seq['length']; i++) {
      var model = seq[i];
      var key = model ? (model.id || i) : i; // KEY function.
      used[key] = true;
      var inst_scope;
      if (hasOwn['call'](has, key)) {
        inst_scope = has[key];
        // retained: add it back to the list of inner scopes.
        rep_scope.dom['push'](inst_scope);
        rep_scope.inner['push'](inst_scope);
        // move the existing dom nodes into the correct place (if order has changed)
        move_scope(inst_scope, parent, after);
      } else {
        // create an inner scope with bind_as bound to the model.
        inst_scope = Scope(rep_scope, rep_scope.contents); // component `contents` available within `repeat` nodes.
        inst_scope.binds[bind_as] = { value:model, wait:-1 }; // dep.
        has[key] = inst_scope;
        spawn_tpl(doc, parent, after, body_tpl, inst_scope, inst_scope.dom);
        rep_scope.dom['push'](inst_scope);
        // NB. new scope adds itself to rep_scope.inner.
      }
      after = inner;
    }
    // destroy all unused inner-scopes.
    for (var key in has) {
      if (hasOwn['call'](has, key) && !hasOwn['call'](used, key)) {
        var del_scope = has[key];
        // remove dom nodes and unbind watches.
        reset_scope(del_scope);
        // discard the scope for GC.
        delete has[key];
      }
    }
  }

  function repeat_once(doc, parent, after, seq, body_tpl, bind_as, rep_scope) {
    for (var i=0; i<seq['length']; i++) {
      var model = seq[i];
      // var key = model ? (model.id || i) : i; // KEY function.
      var inst_scope = Scope(rep_scope, rep_scope.contents); // component `contents` available within `repeat` nodes.
      // TODO: are models deps?
      inst_scope.binds[bind_as] = { value:model, wait:-1 }; // dep.
      spawn_tpl(doc, parent, after, body_tpl, inst_scope, inst_scope.dom);
      rep_scope.dom['push'](inst_scope);
      after = inst_scope;
    }
  }

  function create_repeat(doc, parent, after, scope) {
    // Creates a scope (v-dom) representing the contents of the repeat node.
    // When the expression value changes, iterates over the new value creating
    // and destroying repeats to bring the view into sync with the value.
    var bind_as = sym_list[tpl[p++]]; // TODO: flatten scopes -> becomes an index.
    var body_tpl = tpl[p++];
    var dep = resolve_expr(scope);
    var rep_scope = Scope(scope, scope.contents); // component `contents` available within `repeat` nodes.
    if (dep.wait<0) {
      // constant value.
      if (dep.value instanceof Array) {
        repeat_once(doc, parent, after, dep.value, body_tpl, bind_as, rep_scope);
      }
    } else {
      // varying value.
      var watch = { value:null, wait:0, fwd:[], fn:dep_upd_repeat, parent:parent, after:after,
                    body_tpl:body_tpl, bind_as:bind_as, scope:rep_scope, has:{} }; // dep.
      dep.fwd['push'](watch);
    }
    return rep_scope;
  }

  var create = [
    create_text,       // 0
    create_bound_text, // 1
    create_tag,        // 2
    create_component,  // 3
    create_condition,  // 4
    create_repeat,     // 5
  ];

  function spawn_nodes(doc, parent, after, scope, capture) {
    // spawn a list of children within a tag, component, if/repeat.
    // in order to move dom subtrees, scopes must capture child nodes.
    var len = tpl[p++];
    for (var i=0; i<len; i++) {
      var op = tpl[p++];
      var next = create[op](doc, parent, after, scope);
      next.bk = after; // backwards link for finding previous DOM nodes.
      if (capture) capture['push'](next); // capture top-level nodes in a scope.
      after = next;
    }
  }

  function spawn_tpl(doc, parent, after, tpl_id, scope, capture) {
    // cursor is shared state: no multiple returns, not going to return arrays, could pass an object?
    var save_p = p;
    p = tpl[tpl_id]; // get tpl offset inside tpl array.
    if (debug) console.log("spawn tpl:", tpl_id+" at "+p);
    spawn_nodes(doc, parent, after, scope, capture);
    p = save_p; // must restore because templates can be recursive.
  }

  // ---- init ----

  manglr.bind_doc = function (doc, payload, data) {
    tpl = payload[0];
    sym_list = payload[1];
    var root_scope = Scope(null, null);
    console.log(root_scope); // DEBUGGING.
    spawn_tpl(doc, doc.body, null, 0, root_scope, null);
  };

})(manglr, Node, Array, Object, Error);
