/* <~> Manglr 0.3 | by Andrew Towers | MIT License | https://github.com/raffecat/manglr-proto */

var debug = true;
var log_expr = true;
var log_spawn = false;
var log_deps = true;

manglr = (function(Array, Object){
  "use strict";

  var hasOwn = Object['prototype']['hasOwnProperty'];
  var next_sid = 1;
  var null_dep = { val:null, wait:-1 }; // dep.
  var json_re = new RegExp("^application\/json", "i");
  var sym_list; // Array: symbol strings.
  var tpl; // Array: encoded templates.
  var p = 0; // read position in tpl being spawned.
  var scheduled = false;
  var dirty_roots = [];
  var in_transaction = null;
  var dep_n = 1;
  var fragment;
  var found_parent;


  // -+-+-+-+-+-+-+-+-+ Network -+-+-+-+-+-+-+-+-+

  function postJson(url, data, callback) {
    var tries = 0;
    post();
    function retry(ret) {
      tries++;
      if (ret === true || tries < 5) {
        var delay = Math.min(tries * 1000, 5000); // back-off.
        setTimeout(post, delay);
      }
    }
    function post() {
      var req = new XMLHttpRequest();
      req.onreadystatechange = function () {
        if (!req || req.readyState !== 4) return;
        var code = req.status, data = req.responseText, ct = req.getResponseHeader('Content-Type');
        if (debug) console.log("REQUEST", req);
        req.onreadystatechange = null;
        req = null;
        var data;
        if (json_re.test(ct)) {
          try {
            data = JSON.parse(data);
          } catch (err) {
            console.log("bad JSON", url, err);
            return retry(callback(code||500));
          }
        }
        if (code < 300) {
          if (callback(code, data) === true) retry();
        } else {
          retry(callback(code||500, data));
        }
      };
      req.open('POST', location.protocol+'//'+location.host+url, true);
      req.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
      req.send(JSON.stringify(data));
    }
  }


  // -+-+-+-+-+-+-+-+-+ DOM Manipulation -+-+-+-+-+-+-+-+-+

  function first_dom_node_in_tree(child) {
    // search all contents of these nodes first.
    for (; child; child = child.next_s) {
      // if (debug) console.log("... search node:", child);
      var found = child.dom;
      if (found) return found;
      var subtree = child.first;
      if (subtree) {
        if (debug) console.log("... entering sub-tree:", child);
        found = first_dom_node_in_tree(subtree);
        if (debug) console.log("... leaving sub-tree:", child);
        if (found) return found;
      }
    }
  }

  function first_dom_node_after(scope) {
    // if (debug) console.log("first_dom_node_after:", scope);
    found_parent = null;
    for (;;) {
      // always ignore the children of the starting scope (want a node _after_ those)
      // always ignore the `dom` of the starting node (want a node _after_ this one)
      // check all siblings that follow the starting node.
      var found = first_dom_node_in_tree(scope.next_s);
      if (found) {
        if (debug) console.log("... FOUND:", found);
        found_parent = found.parentNode;
        return found;
      }
      // didn't find a dom node in any forward sibling of the scope.
      // move up one level and check all siblings that follow the parent scope.
      //  A [B] C D    <-- scope.up
      //     1 [2] 3   <-- starting scope [2]
      scope = scope.up;
      if (debug) console.log("... go up to:", scope);
      if (!scope) {
        if (debug) console.log("... STOPPED - no parent DOM node found.");
        return null;
      }
      if (scope.dom) {
        // have arrived at a parent DOM node, therefore there are no other DOM nodes
        // after the initial `scope` that are inside this parent node.
        if (debug) console.log("... STOPPED at the parent DOM node:", scope);
        found_parent = scope.dom;
        return null;
      }
    }
  }

  function move_scope(scope) {
    // move the dom contents of a scope to a new position in the dom.
    // must walk the top-level nodes and scopes (and their top-level nodes)
    if (debug) console.log("[e] move scope:", scope);
    // TODO.
  }


  // -+-+-+-+-+-+-+-+-+ Scopes -+-+-+-+-+-+-+-+-+

  function new_scope(up, contents) {
    // a binding context for names lexically in scope.
    // find bound names in `b` or follow the `up` scope-chain.
    var s = { up:up, next_s:null, prev_s:null, first:null, last:null, dom:null, binds:null, contents:contents };
    if (debug) s.id = 's'+(next_sid++);
    if (up) {
      // append new scope to parent scope.
      var behind = up.last;
      s.prev_s = behind;
      up.last = s;
      if (behind) behind.next_s = s; else up.first = s;
    }
    return s;
  }

  function unlink(parent, node) {
    var behind = node.prev_s, ahead = node.next_s;
    if (behind) behind.next_s = ahead; else parent.first = ahead;
    if (ahead) ahead.prev_s = behind; else parent.last = behind;
  }

  function link_before(parent, node, ahead) {
    var behind = ahead ? ahead.prev_s : parent.last; // null -> append.
    node.prev_s = behind;
    node.next_s = ahead;
    if (behind) behind.next_s = node; else parent.first = node;
    if (ahead) ahead.prev_s = node; else parent.last = node;
  }

  function reset_scope(vnode) {
    // reset [destroy] all the spawned contents in the scope.
    // NB. don't clear `binds`, `up`, `contents` because the scope can be re-populated.
    var dom = vnode.dom;
    if (dom) {
      dom.parentNode.removeChild(dom);
      vnode.dom = null; // GC.
    }
    for (var child = vnode.first; child; ) {
      var next_s = child.next_s;
      reset_scope(child);
      child.next_s = child.prev_s = null; // GC.
      child = next_s;
    }
    vnode.first = vnode.last = null; // GC.
    // TODO: unlink all deps registered in each node.
  }

  function name_from_scope(scope, name) {
    // walk up the scope chain and find the name.
    // TODO: scopes don't need dynamic names -> use vectors; `up` is a prefix.
    do {
      var binds = scope.binds;
      if (binds && hasOwn['call'](binds, name)) {
        if (log_expr) console.log("[e] name_from_scope: "+name+" -> ", binds[name]);
        return binds[name];
      }
      scope = scope.up; // TODO: stop at component boundary.
    } while (scope);
    // the name was not found in the scope chain, which is a compile-time
    // error and should not happen at run-time (even so, do not crash)
    if (debug) console.log("name '"+name+"' not found in scope", scope);
    return null_dep;
  }

  // Scope names are always bound to a Model, Collection or Dep (Expr/Slot/Const)
  // A name in a scope cannot be re-bound, and names cannot be added.
  // Therefore scopes can be vectorised.

  // Fields in a Model are pre-defined. If nothing observes a field, it need not exist.
  // However, any Model can be passed in to any template at run-time (unless typed)
  // Therefore the used fields cannot be pre-determined.
  // When data is loaded into a model (or changes applied) -> update the deps.


  // -+-+-+-+-+-+-+-+-+ Dependency Updates -+-+-+-+-+-+-+-+-+

  function recursive_inc(dep) {
    if (debug && !dep.n) dep.n = dep_n++; // DEBUG.
    var old_wait = dep.wait++;
    if (log_deps) console.log("... dep #"+dep.n+" is now waiting for "+dep.wait);
    if (old_wait === 0) {
      // The dep was in ready state, and is now in dirty state.
      // Each downstream dep is now waiting for another upstream dep.
      var fwd = dep.fwd;
      for (var i=0; i<fwd['length']; i++) {
        recursive_inc(fwd[i]);
      }
    }
  }

  function recursive_dec(dep) {
    var new_wait = --dep.wait;
    if (log_deps) console.log("... dep #"+dep.n+" is now waiting for "+new_wait);
    if (new_wait === 0) {
      // the dep is now ready to update.
      if (log_deps) console.log("... dep #"+dep.n+" is now ready (firing update)");
      // update the "val" on the dep (optional)
      var fn = dep.fn; if (fn) fn(dep);
      // Each downstream dep is now waiting for one less upstream dep.
      var fwd = dep.fwd;
      for (var i=0; i<fwd['length']; i++) {
        recursive_dec(fwd[i]);
      }
    }
  }

  function update_all_dirty() {
    // Run an update transaction (mark and sweep pass over dirty deps)
    // Any deps marked dirty dring processing will be queued for another transaction.
    var roots = dirty_roots;
    if (log_deps) console.log("[d] update all deps: "+roots['length']);
    if (roots['length']) {
      dirty_roots = []; // reset to capture dirty deps for next transaction.
      // Increment wait counts on dirty deps and their downstream deps.
      // Mark the root deps clean so they will be queued if they become dirty again.
      for (var n=0; n<roots['length']; n++) {
        var dep = roots[n];
        dep.dirty = false; // mark clean (before any updates happen)
        recursive_inc(roots[n]);
      }
      // At this point all deps are clean and can be made dirty again during update.
      // Decrement wait counts on deps and run their update when ready.
      // NB. roots.length can change due to fix-ups - DO NOT CACHE LENGTH.
      in_transaction = roots; // expose for fix-ups.
      for (var n=0; n<roots['length']; n++) {
        // Each root dep is now waiting for one less upstream (scheduled update is "ready")
        if (log_deps) console.log("... queue decr for dep #"+roots[n].n);
        recursive_dec(roots[n]);
      }
      in_transaction = null;
    }
    // Re-schedule if there are any dirty deps, otherwise go idle.
    if (dirty_roots['length']) setTimeout(update_all_dirty, 10);
    else scheduled = false;
  }

  function mark_dirty(dep) {
    // Queue the dep for the next update transaction.
    // NB. cannot modify the "wait" count because this might happen during an update transaction!
    // Therefore instead we mark root (provoking) deps "dirty" and queue them.
    if (dep.dirty) return; // early out: already dirty.
    if (dep.wait < 0) return; // do not mark const deps dirty (would corrupt its "wait")
    dep.dirty = true;
    dirty_roots['push'](dep);
    if (!scheduled) {
      scheduled = true;
      if (log_deps) console.log("[d] scheduled an update");
      setTimeout(update_all_dirty, 0);
    }
  }

  function subscribe_dep(src_dep, sub_dep) {
    // Make sub_dep depend on src_dep.
    // This can be used within an update transaction and on deps that are alredy connected
    // to other deps and waiting for updates, so it needs to handle lots of edge-cases.
    if (sub_dep.wait < 0) return; // cannot subscribe a const dep (would corrupt its "wait")
    var fwd = src_dep.fwd, len = fwd['length'];
    for (var i=0; i<len; i++) {
      if (fwd[i] === sub_dep) return; // already present (would corrupt "wait" by decr. twice)
    }
    fwd[len] = sub_dep; // append.
    // If src_dep is currently waiting (i.e. has told downstream deps to expect an update)
    // then sub_dep will receive a recursive_dec() as part of the currently running transaction.
    if (src_dep.wait > 0) {
      recursive_inc(sub_dep);
    } else {
      // We need to ensure that sub_dep will get updated at some point, since it has upstream
      // deps and presumably wants to derive something from them. Add it to the running
      // transaction or mark it dirty if not inside a transaction.
      if (in_transaction) {
        // Avoid extra work if the dep is already waiting on another dep (i.e. will update)
        if (!sub_dep.wait) {
          // Mark sub_dep as waiting - now expecting an update (from the queue)
          recursive_inc(sub_dep);
          in_transaction[in_transaction['length']] = sub_dep;
        }
      } else {
        mark_dirty(sub_dep);
      }
    }
  }

  function unsubscribe_dep(src_dep, sub_dep) {
    // Make sub_dep stop depending on src_dep.
    // This can be used within an update transaction and on deps that are alredy connected
    // to other deps and waiting for updates, so it needs to handle lots of edge-cases.
    var fwd = src_dep.fwd, last = fwd['length'] - 1;
    for (var i=0; i<=last; i++) {
      if (fwd[i] === sub_dep) {
        // Remove sub_dep from the array by moving the last element down.
        fwd[i] = fwd[last]; // spurious if i === last.
        fwd['length'] = last; // discard the last element.
        // If src_dep is currently waiting (i.e. has told downstream deps to expect an update)
        // then we must decrement the wait count in sub_dep because it won't receive that update.
        // else-case: sub_dep is not waiting for a recursive_dec() from this src_dep.
        if (src_dep.wait > 0) {
          // However, if the wait count drops to zero, we only want to update it if it is still
          // active (i.e. depends on other deps, which we can't tell from wait-count alone) and
          // we want to do so from update_all_dirty(), not from inside a call to unsubscribe_dep()
          // Assert: sub_dep.wait must be > 0 here because src_dep.wait was.
          // else-case: sub_dep.wait remains > 0 so it will still be updated later.
          if (sub_dep.wait > 0 && --sub_dep.wait === 0) {
            // NB. sub_dep might still be connected to other deps and intended to update as
            // part of the current transaction, but we just happened to remove the only upstream
            // dep that hadn't delivered its recursive_dec() yet. If that is the case, put
            // back one wait count (for the queue) and append the dep to the transaction queue.
            // Assert: must be inside a transaction here because src_dep.wait was > 0.
            // TODO: don't do this if sub_dep is now inactive (has no upstream deps)
            // else-case: something is broken, because waits cannot be > 0 outside a transaction.
            if (in_transaction) {
              sub_dep.wait = 1;
              in_transaction[in_transaction['length']] = sub_dep;
            }
          }
        }
        return; // exit the search loop.
      }
    }
  }


  // -+-+-+-+-+-+-+-+-+ Models -+-+-+-+-+-+-+-+-+

  // Note that models work this way because I say so.
  // So, in what way should they work?!
  // Why should models be shareable objects kept alive by refs?
  // Can you pass a whole model (ref) into a template? If so why so?

  function Model(id) {
    this._id = id;
    this._deps = {};
  }
  Model.prototype.get = function(key) {
    // Get the dep for a field of the model.
    // Creates field-deps on demand the first time they are fetched.
    var deps = this._deps;
    if (hasOwn['call'](deps, key)) {
      return deps[key];
    } else {
      var dep = { val:null, wait:0, fwd:[], dirty:false }; // dep.
      if (debug) dep._nom = key; // DEBUGGING.
      deps[key] = dep;
      return dep;
    }
  };
  Model.prototype.load = function(data) {
    // Update the in-memory model and schedule its field deps for update.
    var deps = this._deps;
    for (var key in data) {
      if (hasOwn['call'](data, key)) {
        var dep = deps[key];
        if (dep instanceof Model) {
          // Model or Collection in Model field.
          // FIXME: cannot happen, because every Model field is a slot-dep (as created below)
          // that can hold a Model or raw data as its value.
          // FIXME: problem with the design: load() is meant to load structured data
          // into nested Models and Collections of Models; this means load() must find
          // and traverse those things - can they be values in field deps?
          // if not, how can you capture a ref to a Model in some Collection?
          dep.load(data[key]);
        } else if (dep) {
          // Existing dep - update its value and mark dirty.
          dep.val = data[key];
          mark_dirty(dep);
        } else {
          // New root dep - create in ready state with the new value.
          // No need to mark it dirty because there are no listeners yet,
          // and new listeners will mark themselves dirty.
          dep = { val:data[key], wait:0, fwd:[], dirty:false }; // dep.
          if (debug) dep._nom = key; // DEBUGGING.
          deps[key] = dep;
        }
      }
    }
  };
  Model.prototype.update = function(data) {
    // Apply changes to the in-memory model and queue changes for saving.
    this.load(data);
    // TODO: queue the model to save changes to its stores if any.
  };


  // -+-+-+-+-+-+-+-+-+ Expressions -+-+-+-+-+-+-+-+-+

  function is_true(val) {
    // true for non-empty collection or _text_ value.
    return val instanceof Array ? val['length'] : (val || val===0);
  }

  function dep_upd_copy_value(dep) {
    // Copy the value from another dep into this dep.
    dep.val = dep.src_dep.val;
  }

  function dep_upd_field(dep) {
    var new_val = dep.src_dep.val, copier = dep.copier;
    if (new_val !== dep.old_val) {
      // Model or immutable data has changed (or swapping between these)
      if (copier && copier.src_dep) {
        // Must remove our copier from the old model-field dep.
        unsubscribe_dep(copier.src_dep, copier);
      }
      if (new_val instanceof Model) {
        // Subscribe a copier to the model-field dep to copy its value to our dep.
        if (!copier) dep.copier = copier = { val:null, wait:0, fwd:[], fn:dep_upd_copy_value, src_dep:null }; // dep.
        var from_dep = new_val.get(dep.field);
        copier.src_dep = from_dep;
        subscribe_dep(from_dep, copier); // can happen during transaction.
        dep.val = from_dep.val; // update now.
      } else {
        // Update this dep from the new immutable data.
        dep.val = (new_val != null) ? new_val[dep.field] : null;
      }
      dep.old_val = new_val;
    }
  }

  function expr_scope_lookup(scope) {
    // This operation combines scope lookup and one or more dependent field lookups.
    // TODO: Consider splitting these up into separate expression ops.
    var len = tpl[p]; p += 1;
    if (len < 1) return null_dep; // TODO: eliminate.
    // resolve paths by creating deps that watch fields.
    var top_name = sym_list[tpl[p]];
    var dep = name_from_scope(scope, top_name);
    for (var i=1; i<len; i++) {
      var name = sym_list[tpl[p+i]];
      if (i === 1) {
        if (dep instanceof Model) {
          // Get a dep from the model that we obtained from the scope.
          // Scope cannot be changed, so the field will always come from the same model.
          dep = dep.get(name);
          continue;
        } else if (dep.wait<0) {
          // Constant dep from the scope (typically an argument to a component)
          // Make a const dep from the field of the raw scope value.
          var model = dep.val;
          var val = (model != null) ? model[name] : null;
          dep = { val:val, wait:-1 }; // dep.
          continue;
        }
      }
      // Varying dep: field of a dep containing a Model or structured data.
      // Make a field dep that retrieves the value when the upstream changes.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_field, src_dep:dep, field:name, old_val:null, copier:null }; // dep.
      dep_upd_field(watch); // TODO: unless any input has "no value"
      if (dep.wait >= 0) dep.fwd['push'](watch); else watch.wait = -1; // constant.
      dep = watch;
    }
    p += len;
    return dep;
  }

  function to_text(val) {
    return (val == null || val instanceof Object) ? '' : (''+val);
  }

  function dep_upd_concat(dep) {
    // concatenate text fragments from each input dep.
    var args = dep.args;
    var text = "";
    for (var i=0; i<args['length']; i++) {
      var val = args[i].val;
      text += to_text(val);
    }
    dep.val = text;
  }

  function expr_concat_text(scope) {
    // create a dep that updates after all arguments have updated.
    var args = [];
    var dep = { val:"", wait:0, fwd:[], fn:dep_upd_concat, args:args }; // dep.
    var len = tpl[p++];
    if (log_expr) console.log("[e] concat: "+len);
    var ins = 0;
    for (var i=0; i<len; i++) {
      var src = resolve_expr(scope);
      args['push'](src);
      if (src.wait >= 0) { src.fwd['push'](dep); ++ins; } // depend on.
    }
    dep_upd_concat(dep); // TODO: unless any input has "no value"
    if (!ins) { dep.wait = -1; } // constant.
    return dep;
  }

  function dep_upd_equals(dep) {
    dep.val = (dep.lhs.val === dep.rhs.val);
  }

  function expr_equals(scope) {
    // create a dep that updates after both arguments have updated.
    var left = resolve_expr(scope);
    var right = resolve_expr(scope);
    if (log_expr) console.log("[e] equals:", left, right);
    var dep = { val:"", wait:0, fwd:[], fn:dep_upd_equals, lhs:left, rhs:right }; // dep.
    var ins = 0;
    if (left.wait >= 0) { left.fwd['push'](dep); ++ins; } // depend on.
    if (right.wait >= 0) { right.fwd['push'](dep); ++ins; } // depend on.
    dep_upd_equals(dep); // TODO: unless any input has "no value"
    if (!ins) { dep.wait = -1; } // constant.
    return dep;
  }

  function expr_const_text() {
    var val = sym_list[tpl[p++]];
    if (log_expr) console.log("[e] const text: "+val);
    return { val: val, wait: -1 }; // dep.
  }

  function expr_const_num() {
    var val = tpl[p++];
    if (log_expr) console.log("[e] const number: "+val);
    return { val: val, wait: -1 }; // dep.
  }

  var expr_ops = [
    expr_const_text,
    expr_const_num,
    expr_scope_lookup,
    expr_concat_text,
    expr_equals,
    // expr_add,
    // expr_sub,
    // expr_mul,
    // expr_div,
  ];

  function resolve_expr(scope) {
    var op = tpl[p++];
    return expr_ops[op](scope);
  }


  // -+-+-+-+-+-+-+-+-+ Templates -+-+-+-+-+-+-+-+-+

  function dep_upd_text_attr(dep) {
    // update a DOM Element attribute from an input dep's value.
    var node = dep.node;
    var name = dep.attr_name;
    var val = dep.src_dep.val;
    if (val == null) { // or undefined.
      node['removeAttribute'](name); // is this actually a feature we need?
    } else {
      node['setAttribute'](name, to_text(val));
    }
  }

  function dep_upd_bool_attr(dep) {
    // update a DOM Element attribute from an input dep's value.
    var node = dep.node;
    var name = dep.attr_name;
    var val = dep.src_dep.val;
    node[name] = !! is_true(val); // cast to boolean.
  }

  function add_class(elem, cls) {
    var clist = elem.classList;
    if (clist) {
      // classList is fast and avoids spurious reflows.
      clist['add'](cls);
    } else {
      // check if the class is already present.
      var classes = elem['className'];
      var list = classes['split'](' ');
      for (var i=0; i<list['length']; i++) {
        if (list[i] === cls) return;
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
      var list = elem['className']['split'](' '), dirty = false;
      for (var i=0; i<list['length']; i++) {
        if (list[i] === cls) {
          list['splice'](i--, 1);
          dirty = true;
        }
      }
      // avoid setting className unless we actually changed it.
      if (dirty) elem['className'] = list['join'](' ');
    }
  }

  function dep_upd_bound_classes(dep) {
    // bound text expr can contain any number of classes.
    var val = dep.src_dep.val;
    var classes = to_text(val);
    var old_val = dep.old_val;
    if (classes !== old_val) {
      dep.old_val = classes;
      if (old_val) {
        var rm_list = old_val['split'](' ');
        for (var i=0; i<rm_list['length']; i++) {
          remove_class(dep.node, rm_list[i]);
        }
      }
      if (classes) {
        var add_list = classes['split'](' ');
        for (var i=0; i<add_list['length']; i++) {
          add_class(dep.node, add_list[i]);
        }
      }
    }
  }

  function dep_upd_cond_class(dep) {
    // single class bound to a boolean expression.
    (is_true(dep.src_dep.val) ? add_class : remove_class)(dep.node, dep.cls_name);
  }

  function attr_literal_text(node) {
    if (log_spawn) console.log("[a] literal text: "+sym_list[tpl[p+1]]+" = "+sym_list[tpl[p+2]]);
    node['setAttribute'](sym_list[tpl[p+1]], sym_list[tpl[p+2]]);
    p += 3;
  }

  function attr_literal_bool(node) {
    if (log_spawn) console.log("[a] set boolean: "+sym_list[tpl[p+1]]+" = "+sym_list[tpl[p+2]]);
    node[sym_list[tpl[p+1]]] = !! tpl[p+2]; // cast to bool.
    p += 3;
  }

  function attr_bound_text(node, scope) {
    // bound text attribute.
    var name = sym_list[tpl[p+1]];
    if (log_spawn) console.log("[a] bound text: "+sym_list[tpl[p+1]]);
    p += 2;
    var dep = resolve_expr(scope);
    if (dep.wait<0) {
      // constant value.
      var val = dep.val;
      if (val != null) { // or undefined.
        node['setAttribute'](name, to_text(val));
      }
    } else {
      // varying value.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_text_attr, node:node, src_dep:dep, attr_name:name }; // dep.
      dep.fwd['push'](watch);
      dep_upd_text_attr(watch); // update now.
    }
  }

  function attr_bound_bool(node, scope) {
    // bound boolean attribute.
    var name = sym_list[tpl[p+1]];
    if (log_spawn) console.log("[a] bound boolean: "+sym_list[tpl[p+1]]);
    p += 2;
    var dep = resolve_expr(scope);
    if (dep.wait<0) {
      // constant value.
      node[name] = !! is_true(dep.val); // cast to bool.
    } else {
      // varying value.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_bool_attr, node:node, src_dep:dep, attr_name:name }; // dep.
      dep.fwd['push'](watch);
      dep_upd_bool_attr(watch); // update now.
    }
  }

  function attr_literal_class(node, scope, cls) {
    if (log_spawn) console.log("[a] literal class: "+sym_list[tpl[p+1]]);
    cls['push'](sym_list[tpl[p+1]]);
    p += 2;
  }

  function attr_bound_class(node, scope, cls) {
    p += 1;
    var dep = resolve_expr(scope);
    if (log_spawn) console.log("[a] bound class:", dep);
    if (dep.wait<0) {
      // constant value.
      var val = dep.val;
      var classes = to_text(val);
      if (classes) cls['push'](classes); // class text.
    } else {
      // varying value.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_bound_classes, node:node, src_dep:dep, old_val:'' }; // dep.
      dep.fwd['push'](watch);
      dep_upd_bound_classes(watch); // update now.
    }
  }

  function attr_cond_class(node, scope, cls) {
    var name = sym_list[tpl[p+1]];
    p += 2;
    var dep = resolve_expr(scope);
    if (log_spawn) console.log("[a] conditional class:", name, dep);
    if (dep.wait<0) {
      // constant value.
      if (is_true(dep.val)) cls['push'](name);
    } else {
      // varying value.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_cond_class, node:node, src_dep:dep, cls_name:name }; // dep.
      dep.fwd['push'](watch);
      dep_upd_cond_class(watch); // update now.
    }
  }

  function attr_bound_style(node, scope) {
  }

  var attr_ops = [
    attr_literal_text,
    attr_literal_bool,
    attr_bound_text,
    attr_bound_bool,
    attr_literal_class,
    attr_bound_class,
    attr_cond_class,
    attr_bound_style,
  ];

  function dep_upd_text_node(dep) {
    // update a DOM Text node from an input dep's value.
    var val = dep.src_dep.val;
    dep.node.data = to_text(val);
  }

  function create_text(up_scope, append_to) {
    // create a DOM Text node with literal text.
    var dom_scope = new_scope(up_scope, 0);
    // create a Text Node.
    var text = sym_list[tpl[p++]];
    if (log_spawn) console.log("[s] createTextNode:", text);
    var node = document.createTextNode(text);
    // always build dom sub-trees by appending inside a document fragment.
    append_to.appendChild(node);
    // record the DOM node on the scope, so we can find and move it.
    dom_scope.dom = node;
  }

  function create_bound_text(up_scope, append_to) {
    // create a DOM Text node with a bound expression.
    var dom_scope = new_scope(up_scope, 0);
    var dep = resolve_expr(up_scope);
    var text = (dep.wait < 0) ? to_text(dep.val) : "";
    if (log_spawn) console.log("[s] createTextNode:", dep);
    var node = document.createTextNode(text);
    if (dep.wait >= 0) {
      // bound text content.
      var watch = { val:"", wait:0, fwd:[], fn:dep_upd_text_node, node:node, src_dep:dep }; // dep.
      dep.fwd['push'](watch);
      dep_upd_text_node(watch); // update now.
    }
    // always build dom sub-trees by appending inside a document fragment.
    append_to.appendChild(node);
    // record the DOM node on the scope, so we can find and move it.
    dom_scope.dom = node;
  }

  function create_element(up_scope, append_to) {
    // create a DOM Element node.
    var dom_scope = new_scope(up_scope, up_scope.contents); // pass through component-level `contents`.
    // create an Element Node.
    var tag = sym_list[tpl[p++]];
    if (log_spawn) console.log("[s] createElement:", tag);
    var node = document.createElement(tag);
    var nattrs = tpl[p++];
    var cls = [];
    // apply attributes and bindings (grouped by type)
    while (nattrs--) {
      attr_ops[tpl[p]](node, up_scope, cls);
    }
    if (cls.length) node.className = cls.join(' ');
    // spawn any child scopes inside this dom_scope.
    spawn_child_scopes(dom_scope, node);
    // always build dom sub-trees by appending inside a document fragment.
    append_to.appendChild(node);
    // record the DOM node on the scope, so we can find and move it.
    dom_scope.dom = node;
  }

  function create_component(up_scope, append_to) {
    var tpl_id = tpl[p];
    var content_tpl = tpl[p+1];
    var nbinds = tpl[p+2];
    p += 3;
    if (log_spawn) console.log("create component:", tpl_id, content_tpl, nbinds);
    // component has its own scope because it has its own namespace for bound names,
    // but doesn't have an independent lifetime (destroyed with the parent scope)
    var com_scope = new_scope(up_scope, content_tpl); // pass in the instance `contents`.
    com_scope.binds = {};
    for (var i=0; i<nbinds; i++) {
      var name = sym_list[tpl[p++]]; // TODO: flatten scopes into vectors (i.e. remove names)
      var dep = resolve_expr(up_scope);
      if (log_spawn) console.log("bind to component:", name, dep);
      com_scope.binds[name] = dep;
    }
    // pass through `append_to` so child dom nodes will be appended to that node
    // as if the component were replaced with its contents.
    spawn_tpl(tpl_id, com_scope, append_to);
  }

  function dep_upd_condition(dep, o_append_to) {
    // create or destroy the `contents` based on boolean `value`.
    if (is_true(dep.src_dep.val)) {
      if (!dep.in_doc) {
        dep.in_doc = true;
        // spawn all dom nodes, bind watches to deps in the scope.
        spawn_tpl(dep.body_tpl, dep.cond_scope, o_append_to);
      }
    } else {
      if (dep.in_doc) {
        dep.in_doc = false;
        reset_scope(dep.cond_scope); // remove all DOM nodes and unlink all deps.
      }
    }
  }

  function create_condition(up_scope, append_to) {
    // Creates a scope (v-dom) representing the contents of the condition node.
    // The scope toggles between active (has dom nodes) and inactive (empty).
    // TODO: must bind all locally defined names in the scope up-front.
    // => controllers inside cond/repeat are conditionally active, but still exist.
    var body_tpl = tpl[p++];
    var src_dep = resolve_expr(up_scope);
    var cond_scope = new_scope(up_scope, up_scope.contents); // pass through component-level `contents`.
    // always create a dep to track the condition state (used for removal, if not updating)
    var cond_dep = { val:null, wait:0, fwd:[], fn:dep_upd_condition, src_dep:src_dep,
                     body_tpl:body_tpl, cond_scope:cond_scope, in_doc:false }; // dep.
    if (src_dep.wait >= 0) src_dep.fwd['push'](cond_dep); // subscribe.
    // FIXME: calls spawn_and_insert_tpl in the middle of populating `fragment`,
    // and without passing through dom_parent (how will it derive dom_parent and dom_before?)
    dep_upd_condition(cond_dep, append_to); // update now in `append_to` mode.
  }

  function dep_upd_repeat(dep, o_append_to) {
    var seq = dep.src_dep.val instanceof Array ? dep.src_dep.val : [];
    var body_tpl = dep.body_tpl;
    var bind_as = dep.bind_as;
    var rep_scope = dep.rep_scope;
    var have_keys = dep.have_keys;
    var new_keys = {};
    var next_scope = rep_scope.first; // first existing child scope (can be null)
    for (var i=0; i<seq['length']; i++) {
      var model = seq[i];
      var key = model ? (model._id || i) : i; // KEY function.
      var inst_scope;
      if (hasOwn['call'](have_keys, key)) {
        inst_scope = have_keys[key];
        if (inst_scope) {
          // retained: move into place if necessary.
          if (inst_scope === next_scope) {
            // already in place: advance to the next existing scope (can be null)
            next_scope = next_scope.next_s;
          } else {
            // unlink the existing instance scope.
            unlink(rep_scope, inst_scope);
            // insert it back in before next_scope.
            link_before(rep_scope, inst_scope, next_scope);
            // move the scope's dom nodes into the correct place.
            move_scope(inst_scope);
          }
        }
      } else {
        // create a sub-scope with bind_as bound to the model.
        inst_scope = new_scope(null, rep_scope.contents); // pass through component-level `contents`.
        inst_scope.up = rep_scope; // manually inserted in parent scope (below)
        var binds = {};
        binds[bind_as] = { val:model, wait:-1 }; // dep.
        inst_scope.binds = binds;
        have_keys[key] = inst_scope;
        // link it in at the current place.
        link_before(rep_scope, inst_scope, next_scope);
        // spawn child scopes in the correct place.
        spawn_tpl(body_tpl, inst_scope, o_append_to);
      }
      new_keys[key] = inst_scope;
    }
    dep.have_keys = new_keys;
    // destroy all remaining unused child scopes.
    while (next_scope) {
      var after = next_scope.next_s; // capture before unlink.
      unlink(rep_scope, next_scope);
      reset_scope(next_scope); // remove all DOM nodes and unlink all deps.
      next_scope = after;
    }
  }

  function create_repeat(up_scope, append_to) {
    // Creates a scope representing the contents of the repeat node.
    // When the expression value changes, iterates over the new value creating
    // and destroying child scopes to bring the view into sync with the value.
    var bind_as = sym_list[tpl[p++]]; // TODO: flatten scopes -> becomes an index.
    var body_tpl = tpl[p++];
    var src_dep = resolve_expr(up_scope);
    var rep_scope = new_scope(up_scope, up_scope.contents); // pass through component-level `contents`.
    // always create a dep to track the repeat state (used for removal, if not updating)
    var rep_dep = { val:null, wait:0, fwd:[], fn:dep_upd_repeat, src_dep:src_dep,
                    body_tpl:body_tpl, bind_as:bind_as, rep_scope:rep_scope, have_keys:{} }; // dep.
    if (src_dep.wait >= 0) src_dep.fwd['push'](rep_dep); // subscribe.
    dep_upd_repeat(rep_dep, append_to); // update now in `append_to` mode.
  }

  function dep_bind_to_hash_change(dep) {
    dep.val = location.hash;
    function hash_change() {
      var hash = location.hash;
      if (hash !== dep.val) {
        dep.val = hash;
        mark_dirty(dep);
      }
    }
    addEventListener('hashchange', hash_change, false);
  }

  function create_router(scope) {
    var bind_as = sym_list[tpl[p++]];
    var router = new Model(bind_as);
    scope.binds[bind_as] = router;
    var route_dep = { val:null, wait:0, fwd:[], dirty:false }; // dep.
    if (debug) route_dep._nom = 'route';
    router._deps['route'] = route_dep;
    dep_bind_to_hash_change(route_dep); // avoids capturing doc, dom_parent, etc.
  }

  function create_auth(scope) {
    var bind_as = sym_list[tpl[p++]];
    var auth = new Model(bind_as);
    scope.binds[bind_as] = auth;
    var auth_required = { val:false, wait:0, fwd:[], dirty:false }; // dep.
    if (debug) auth_required._nom = 'auth_required';
    auth._deps['auth_required'] = auth_required;
  }

  function store_set_state(store, state) {
    store.state = state;
    var deps = store._deps;
    var loading = (state == 0); // 0 = loading.
    var error = (state == 1);   // 1 = error.
    var loaded = (state == 2);  // 2 = loaded.
    if (deps.loading.val !== loading) { deps.loading.val = loading; mark_dirty(deps.loading); }
    if (deps.error.val !== error) { deps.error.val = error; mark_dirty(deps.error); }
    if (deps.loaded.val !== loaded) { deps.loaded.val = loaded; mark_dirty(deps.loaded); }
  }

  function dep_load_store_items(store, get_url, items_dep) {
    store_set_state(store, 0); // 0 = loading.
    postJson(get_url, {}, function (code, data) {
      if (debug) console.log("manglr: store fetch: "+get_url, code, data);
      if (code === 200 && data) {
        data = data.d || data || {}; // unwrap quirky json.
        var items = null;
        if (data instanceof Array) items = data;
        else if (data['items'] instanceof Array) items = data['items']; // TODO: option (a path)
        if (items) {
          items_dep.val = items || []; mark_dirty(items_dep);
          store_set_state(store, 2); // 2 = loaded.
        } else {
          store_set_state(store, 1); // 1 = error.
        }
      } else {
        store_set_state(store, 1); // 1 = error.
      }
    });
  }

  function create_store(scope) {
    var bind_as = sym_list[tpl[p++]];
    var get_url = sym_list[tpl[p++]];
    var auth_ref = sym_list[tpl[p++]];
    if (log_spawn) console.log("> STORE "+bind_as);
    var store = new Model(bind_as);
    var deps = store._deps;
    store.state = 0; // 0 = loading.
    scope.binds[bind_as] = store;
    var items_dep = { val:[], wait:0, fwd:[], dirty:false }; // dep.
    deps['items'] = items_dep;
    deps['loading'] = { val:true, wait:0, fwd:[], dirty:false }; // dep.
    deps['error'] = { val:false, wait:0, fwd:[], dirty:false }; // dep.
    deps['loaded'] = { val:false, wait:0, fwd:[], dirty:false }; // dep.
    dep_load_store_items(store, get_url, items_dep);
  }

  var dom_create = [
    create_text,       // 0  text
    create_bound_text, // 1  text
    create_element,    // 2  element
    create_component,  // 3  scope
    create_condition,  // 4  scope
    create_repeat,     // 5  scope
    create_router,     // 6  <router>
    create_auth,       // 7  <authentication>
    create_store,      // 8  <store>
  ];

  function spawn_child_scopes(up_scope, append_to) {
    // spawn a list of children within a dom tag or template body.
    // in order to move scopes, they must capture their top-level nodes.
    var len = tpl[p++];
    for (var i=0; i<len; i++) {
      var op = tpl[p++];
      dom_create[op](up_scope, append_to);
    }
  }

  function spawn_tpl(tpl_id, up_scope, o_append_to) {
    // cursor is shared state: no multiple returns, not going to return arrays, could pass an object?
    if (log_spawn) console.log("spawn tpl: "+tpl_id);
    if (tpl_id) { // zero is the empty template.
      var save_p = p;
      p = tpl[tpl_id]; // get tpl offset inside tpl array.
      spawn_child_scopes(up_scope, o_append_to || fragment);
      p = save_p; // must restore because templates can be recursive.
      if (!o_append_to) {
        // insert the resulting nodes into the scope's `dom_parent`.
        if (fragment.firstChild) {
          var dom_before = first_dom_node_after(up_scope); // -> found_parent.
          found_parent.insertBefore(fragment, dom_before);
        }
      }
    }
  }


  // -+-+-+-+-+-+-+-+-+ Init -+-+-+-+-+-+-+-+-+

  function b93_decode(text) {
    var res = [], len = text.length, i = 0, acc = 0, ch;
    for (;i<len;i++) {
      ch = text.charCodeAt(i);
      if (ch >= 95) {
        acc = (acc << 5) + (ch - 95); // high 5 bits.
      } else {
        if (ch > 92) --ch;
        if (ch > 34) --ch;
        res.push((acc * 61) + (ch - 32)); // low 61 vals.
        acc = 0;
      }
    }
    return res;
  }

  function load_app() {
    var doc = document;
    var body = doc.body;
    var root_scope = new_scope(null, 0);
    root_scope.binds = {};
    root_scope.dom = body; // for `if` or `repeat` in the body tag.
    if (debug) console.log(root_scope); // DEBUGGING.
    fragment = doc['createDocumentFragment']();
    spawn_tpl(1, root_scope, fragment);
    body.insertBefore(fragment, body.firstChild);
  }

  return function (tpl_data, symbols) {
    sym_list = symbols;
    tpl = b93_decode(tpl_data); // unpack tpl data to an array of integers.
    for (var i=2, num=tpl[0]; i<=num; i++) {
      tpl[i] += tpl[i-1]; // make template offsets absolute (encoded relative)
    }
    load_app();
  };

})(Array, Object);
