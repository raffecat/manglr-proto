(function(manglr){
  "use strict";

  var std_attr = new RegExp("^accept-charset$|^http-equiv$|^data-|^aria-");
  var hasOwn = Object.prototype.hasOwnProperty;
  var nextSid = 1;
  var null_dep = { value:null, wait:-1, fwd:null, fn:null }; // dep.
  var is_text = { "boolean":1, "number":1, "string":1, "symbol":1, "undefined":0, "object":0, "function":0 };

  // ---- scopes and deps ----

  function Scope(up, contents) {
    // a binding context for names lexically in scope.
    // find bound names in `b` or follow the `up` scope-chain.
    var s = {dom:[], id:'s'+(nextSid++), binds:{}, up:up, contents:contents, in:[]};
    if (up) up.in.push(s); // register to be destroyed with enclosing scope.
    return s;
  }

  function bind_to_scope(scope, binding, func) {
    // resolve binding - text_tpl or value, might be literal text?
  }

  function move_scope(scope, parent, after) {
  }

  function reset_scope(scope) {
  }

  function name_from_scope(scope, name) {
    // walk up the scope chain and find the name.
    do {
      var binds = scope.binds;
      if (hasOwn.call(binds, name)) {
        return binds[name];
      }
      scope = scope.up;
    } while (scope);
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

  function resolve_in_scope(scope, expr) {
    var len = expr.length;
    if (len < 1) return null_dep;
    // resolve paths by creating deps that watch fields.
    var dep = name_from_scope(scope, expr[0]);
    for (var i=1; i<len; i++) {
      var name = expr[i];
      if (dep.wait<0) {
        // constant value.
        // inline version of dep_upd_field.
        var model = dep.value;
        var val = (model != null) ? model[name] : null;
        // make a const dep with the field value.
        // TODO: if model is actually a model, its fields will be deps.
        // TODO: -> can just use that dep directly.
        dep = { value:val, wait:-1, fwd:null, fn:null }; // dep.
      } else {
        // varying value.
        var watch = { value:null, wait:0, fwd:[], fn:dep_upd_field, from:dep, name:name }; // dep.
        dep.fwd.push(watch);
        dep = watch;
      }
    }
    return dep;
  }

  function dep_upd_text_tpl(dep) {
    // concatenate text fragments from each input dep.
    var args = dep.args;
    var text = "";
    for (var i=0; i<args.length; i++) {
      var val = args[i].value;
      text += is_text[typeof(val)] ? val : "";
    }
    dep.value = text;
  }

  function resolve_text_tpl(scope, tpl) {
    var args = [];
    var dep = { value:"", wait:0, fwd:[], fn:dep_upd_text_tpl, args:args }; // dep.
    for (var i=0; i<tpl.length; i += 2) {
      var arg = tpl[i+1];
      switch (tpl[i]) {
        case 0: args.push({value:arg}); // literal text.
        case 1: args.push(resolve_in_scope(scope, arg)); // expression.
      }
    }
    return dep;
  }

  // ---- creating templates ----

  function is_true(val) {
    // true for non-empty collection or _text_ value.
    return val instanceof Array ? val.length : (val || val===0);
  }

  function last_dom_node(scope) {
    // walk backwards from `scope` following the chain of `bk` references
    // until we find a DOM Node or a Scope that contains a DOM node.
    while (scope !== null) {
      // scan the nodes captured in the scope backwards for the last child.
      var children = scope.dom;
      for (var n=children.length-1; n>=0; n--) {
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
    parent.insertBefore(node, last ? last.nextSibling : parent.firstChild);
  }

  function create_text(doc, parent, after, scope, tpl) {
    // create a text node: [0, "text"]
    var n = tpl.n;
    var node = doc.createTextNode(tpl[n+1]);
    tpl.n = n+2;
    insert_after(parent, after, node);
    return node;
  }

  function dep_upd_text_node(dep) {
    // update a DOM Text node from an input dep's value.
    var val = dep.from.value;
    dep.node.data = is_text[typeof(val)] ? val : '';
  }

  function create_bound(doc, parent, after, scope, tpl) {
    // create a bound text node.
    var n = tpl.n;
    var binding = tpl[n+1]; // [1, expr]
    tpl.n = n+2;
    var node = doc.createTextNode('');
    var dep = resolve_in_scope(scope, binding);
    if (dep.wait<0) {
      // constant value.
      // inline version of dep_upd_text_node.
      var val = dep.value;
      node.data = is_text[typeof(val)] ? val : '';
    } else {
      // varying value.
      var watch = { value:null, wait:0, fwd:[], fn:dep_upd_text_node, node:node, from:dep }; // dep.
      console.log("dep on:", dep);
      dep.fwd.push(watch);
    }
    insert_after(parent, after, node);
    return node;
  }

  function dep_upd_node_attr(dep) {
    // update a DOM Element attribute from an input dep's value.
    var node = dep.node;
    var name = dep.name;
    var val = dep.from.value;
    if (typeof(node[name]) === 'boolean') {
      console.log("BOOLEAN:", name);
      node[name] = !! is_true(val); // cast to boolean.
    } else {
      if (val == null) { // or undefined.
        node.removeAttribute(name);
      } else {
        node.setAttribute(name, is_text[typeof(val)] ? val : '');
      }
    }
  }

  function create_tag(doc, parent, after, scope, tpl) {
    var n = tpl.n;
    var tag = tpl[n+1];
    var attrs = tpl[n+2];
    var bindings = tpl[n+3];
    var contents = tpl[n+4];
    tpl.n = n+5;
    var node = doc.createElement(tag);
    // - className, htmlFor
    // - style
    for (var i=0; i<attrs.length; i+=2) {
      var name = attrs[i];
      var val = attrs[i+1];
      if (typeof(node[name]) === 'boolean') {
        console.log("BOOLEAN:", name);
        node[name] = !! is_true(val); // cast to boolean.
      } else {
        node.setAttribute(name, val);
      }
    }
    for (var i=0; i<bindings.length; i+=2) {
      var name = bindings[i];
      var text_tpl = bindings[i+1];
      var dep = resolve_text_tpl(scope, text_tpl);
      console.log("resolve:", name, text_tpl, dep);
      if (dep.wait<0) {
        // constant value.
        // inline version of dep_upd_node_attr.
        var val = dep.value;
        if (typeof(node[name]) === 'boolean') {
          console.log("BOOLEAN:", name);
          node[name] = !! is_true(val); // cast to boolean.
        } else {
          if (val == null) { // or undefined.
            node.removeAttribute(name);
          } else {
            node.setAttribute(name, is_text[typeof(val)] ? val : '');
          }
        }
      } else {
        // varying value.
        var watch = { value:null, wait:0, fwd:[], fn:dep_upd_node_attr, node:node, from:dep, name:name }; // dep.
        dep.fwd.push(watch);
      }
    }
    insert_after(parent, after, node);
    // passing null `after` because we use our own DOM node as `parent`,
    // so there is never a _previous sibling_ DOM node for our contents.
    spawn_tpl(doc, node, null, contents, scope, null);
    return node;
  }

  function create_component(doc, parent, after, scope, tpl) {
    var n = tpl.n;
    var comp = tpl[n+1];
    var attrs = tpl[n+2];
    var bindings = tpl[n+3];
    var contents = tpl[n+4];
    tpl.n = n+5;
    // component has its own scope because it has its own namespace for bound names,
    // but doesn't have an independent lifetime (destroyed with the parent scope)
    var inner = Scope(scope, contents); // component instance `contents` (a tpl)
    for (var i=0; i<attrs.length; i+=2) {
      var name = attrs[i];
      var val = attrs[i+1];
      // create a dep that represents the literal value.
      inner.binds[name] = { value:val, wait:-1, fwd:null, fn:null }; // dep.
    }
    for (var i=0; i<bindings.length; i+=2) {
      var name = bindings[i];
      var binding = bindings[i+1];
      inner.binds[name] = bind_to_scope(scope, binding); // make a dep.
    }
    // pass through `parent` and `after` so the component tpl will be created inline,
    // as if the component were replaced with its contents.
    spawn_tpl(doc, parent, after, comp.tpl, inner, inner.dom);
    // Must return a Scope to act as `after` for a subsequent Scope node.
    // The scope `dom` must contain all top-level DOM Nodes and Scopes in the tpl.
    return inner;
  }

  function create_condition(doc, parent, after, scope, tpl) {
    // Creates a scope representing the contents of the condition node.
    // The scope toggles between active (has dom nodes) and inactive (empty).
    // TODO: must bind all locally defined names in the scope up-front.
    var n = tpl.n;
    var binding = tpl[n+1];
    var contents = tpl[n+2];
    tpl.n = n+3;
    var inner = Scope(scope, scope.contents); // component `contents` available within `if` nodes.
    var present = false;
    bind_to_scope(scope, binding, function (val, name) {
      if (is_true(val)) {
        if (!present) {
          present = true;
          // spawn all dom nodes, bind watches to deps in the scope.
          // pass through `parent` and `after` so the contents will be created inline.
          spawn_tpl(doc, parent, after, contents, inner, inner.dom);
        }
      } else {
        if (present) {
          present = false;
          // remove all [top-level] dom nodes and unbind all watches.
          // NB. need a list: watches can be bound to parent scopes!
          reset_scope(inner);
        }
      }
    });
    // Must return a Scope to act as `after` for a subsequent Scope node.
    return inner;
  }

  function create_repeat(doc, parent, after, scope, tpl) {
    var n = tpl.n;
    var binding = tpl[n+1];
    var bind_as = tpl[n+2];
    var contents = tpl[n+3];
    tpl.n = n+4;
    // RESOLVE: doesn't need to be a scope, but does need to support 
    // `dom` for insert_after and move_scope, and `reset_scope` for destroy.
    var outer = Scope(scope, scope.contents); // component `contents` available within `repeat` nodes.
    var has = {}; // scope if currently in-document.
    bind_to_scope(scope, binding, function (val, name) {
      var seq = val instanceof Array ? val : [];
      // start at `after` so our contents will follow its DOM nodes.
      var ins_after = after;
      var used = {};
      outer.dom.length = 0; // must rebuild for `insert_after` in following nodes.
      outer.in.length = 0; // must rebuild the list of child scopes.
      for (var i=0; i<seq.length; i++) {
        var model = seq[i];
        var key = model ? (model.id || i) : i;
        used[key] = true;
        var inner;
        if (hasOwn.call(has, key)) {
          inner = has[key];
          // retained: add it back to the list of child scopes.
          outer.dom.push(inner);
          outer.in.push(inner);
          // move the existing dom nodes into the correct place (if order has changed)
          move_scope(inner, parent, ins_after);
        } else {
          // create an inner scope with bind_as bound to the model.
          inner = Scope(outer, scope.contents); // component `contents` available within `repeat` nodes.
          inner.binds[bind_as] = { value:model, wait:-1, fwd:null, fn:null }; // dep.
          has[key] = inner;
          spawn_tpl(doc, parent, ins_after, contents, inner, inner.dom);
          outer.dom.push(inner);
          // NB. new scope adds itself to outer.in.
        }
        ins_after = inner;
      }
      // destroy all unused inner-scopes.
      for (var key in has) {
        if (hasOwn.call(has, key) && !hasOwn.call(used, key)) {
          var inner = has[key];
          // remove dom nodes and unbind watches.
          reset_scope(inner);
          // discard the scope for GC.
          delete has[key];
        }
      }
    });
    return outer;
  }

  var create = [
    create_text,       // 0
    create_bound,      // 1
    create_tag,        // 2
    create_component,  // 3
    create_condition,  // 4
    create_repeat,     // 5
  ];

  function spawn_tpl(doc, parent, after, tpl, scope, capture) {
    // spawn a list of children within a tag, component, if/repeat.
    // in order to move dom subtrees, scopes must capture child nodes.
    var save_n = tpl.n; // cursor: mutated on tpl! (no multiple returns in js)
    tpl.n = 0; // ^ not willing to pay for [] return or closures, so.
    while (tpl.n < tpl.length) {
      var op = tpl[tpl.n];
      // console.log("create", tpl.n, op);
      var next = create[op](doc, parent, after, scope, tpl);
      next.bk = after; // backwards link for finding previous DOM nodes.
      if (capture) capture.push(next); // capture top-level nodes in a scope.
      after = next;
    }
    tpl.n = save_n; // must restore because tpl can be recursive.
  }

  // ---- init ----

  manglr.bind_doc = function (doc, tpl) {
    var root_scope = Scope(null, null);
    spawn_tpl(doc, doc.body, null, tpl, root_scope, null);
  };

})(manglr);
