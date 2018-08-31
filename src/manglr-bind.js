/* <~> Manglr 0.4 | by Andrew Towers | MIT License | https://github.com/raffecat/manglr-proto */

var debug = true;
var log_expr = false;
var log_spawn = false;
var log_deps = false;

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
  var tap_handlers = {};
  var in_transaction = null;
  var dep_n = 1;
  var next_id = 0;
  var fragment;
  var found_parent;


  // -+-+-+-+-+-+-+-+-+ Network -+-+-+-+-+-+-+-+-+

  function postJson(url, token, data, callback) {
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
        req = null; // GC.
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
      if (token) req.setRequestHeader("Authorization", "bearer "+token);
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
    // FIXME: use first_dom_node_after to find the insert-before point,
    // then traverse to find the top-level dom nodes and use insertBefore
    // to move them into place.
  }


  // -+-+-+-+-+-+-+-+-+ DOM Events -+-+-+-+-+-+-+-+-+

  function tap_handler(event) {
    var dom_target = event.target || event.srcElement; // IE 6-8 srcElement.
    for (; dom_target; dom_target = dom_target.parentNode) {
      var dom_id = dom_target.id;
      if (dom_id) {
        var list = tap_handlers['t'+dom_id];
        if (list) {
          for (var i=0; i<list.length; i++) {
            if (list[i](event) === false) {
              if (event.preventDefault) event.preventDefault(); else event.returnValue = false; // IE returnValue.
              if (event.stopPropagation) event.stopPropagation(); else event.cancelBubble = true; // IE cancelBubble.
              return;
            }
          }
        }
      }
    }
  }

  function add_handler(nid, func) {
    var list = tap_handlers[nid];
    if (list) list.push(func); else tap_handlers[nid] = [func];
  }

  // dom_node.addEventListener('touchstart', tap_handler); // TODO: properly.
  document.addEventListener('click', tap_handler, true);


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
    // FIXME: unlink all deps registered in each vnode.
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
      scope = scope.up; // TODO: stop at component boundary (then need to pass in implicit binds)
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
    if (dep.wait < 1) throw 1; // assert: no decrement without increment first.
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
        // Should increment sub_dep in this case if something upstream of src_dep will update,
        // but if that were the case, then src_dep.wait would be > 0 (handled above)
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
            // TODO: don't do this if sub_dep is now inactive (has no upstream deps, or un-bound?)
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
      var dep = mkdep(null);
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
        if (dep) {
          // Existing dep - update its value and mark dirty.
          dep.val = data[key];
          mark_dirty(dep);
        } else {
          // New root dep - create in ready state with the new value.
          // No need to mark it dirty because there are no listeners yet,
          // and new listeners will mark themselves dirty.
          dep = mkdep(data[key]);
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
    // Copy the value from one dep to another.
    var to_dep = dep.val;
    var from_dep = dep.arg;
    to_dep.val = from_dep.val;
  }

  function dep_upd_field(dep) {
    // fires when the upstream dep's value changes.
    // set dep.val to the value of some `field` of the upstream dep's value.
    // if the upstream dep's value is a Model, its `field` will be another dep.
    // in that case, we must subscribe to that dep and copy-out its value.
    var new_val = dep.src_dep.val;
    var copier = dep.copier;
    if (new_val !== dep.old_upstream_val) {
      // Model or immutable data has changed (or swapping between these)
      dep.old_upstream_val = new_val;
      if (copier) {
        // Must remove our copier from the old model field's dep.
        var from_dep = copier.arg;
        if (from_dep) unsubscribe_dep(from_dep, copier);
      }
      if (new_val instanceof Model) {
        // Subscribe a copier to the model field's dep to copy its value to our dep.
        var from_dep = new_val.get(dep.field);
        if (from_dep) {
          if (!copier) dep.copier = copier = mkdep(dep, dep_upd_copy_value, null);
          copier.arg = from_dep; // update `from_dep`.
          subscribe_dep(from_dep, copier); // can happen during transaction.
          dep.val = from_dep.val; // update now.
        } else {
          dep.val = null; // no such field in the model.
        }
      } else {
        // Update this dep from the new immutable data.
        dep.val = (new_val != null) ? new_val[dep.field] : null;
      }
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      if (dep.wait >= 0) dep.fwd.push(watch); else watch.wait = -1; // constant.
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      if (src.wait >= 0) { src.fwd.push(dep); ++ins; } // depend on.
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
    if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
    if (left.wait >= 0) { left.fwd.push(dep); ++ins; } // depend on.
    if (right.wait >= 0) { right.fwd.push(dep); ++ins; } // depend on.
    dep_upd_equals(dep); // TODO: unless any input has "no value"
    if (!ins) { dep.wait = -1; } // constant.
    return dep;
  }

  function dep_upd_not(dep) {
    dep.val = ! dep.rhs.val;
  }

  function expr_not(scope) {
    // create a dep that updates after the argument has updated.
    var right = resolve_expr(scope);
    if (log_expr) console.log("[e] not:", right);
    var dep = { val:"", wait:0, fwd:[], fn:dep_upd_not, rhs:right }; // dep.
    var ins = 0;
    if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
    if (right.wait >= 0) { right.fwd.push(dep); ++ins; } // depend on.
    dep_upd_not(dep); // TODO: unless any input has "no value"
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
    expr_not,
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
      dep_upd_cond_class(watch); // update now.
    }
  }

  function dep_upd_bound_style(dep) {
    // update a DOM Element style from an input dep's value.
    dep.dom_node.style[dep.name] = to_text(dep.src_dep.val);
  }

  function attr_bound_style(dom_node, scope) {
    var name = sym_list[tpl[p+1]];
    p += 2;
    var dep = resolve_expr(scope);
    if (log_spawn) console.log("[a] bound style:", name, dep);
    if (dep.wait<0) {
      // constant value.
      dom_node.style[name] = to_text(dep.val);
    } else {
      // varying value.
      var watch = { val:null, wait:0, fwd:[], fn:dep_upd_bound_style, dom_node:dom_node, src_dep:dep, name:name }; // dep.
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
      dep_upd_bound_style(watch); // update now.
    }
  }

  function attr_tap_sel(dom_node, scope) {
    var cls = sym_list[tpl[p+1]];
    p += 2;
    var expr_dep = resolve_expr(scope);
    var field_dep = resolve_expr(scope);
    if (log_spawn) console.log("[a] tap select:", cls, expr_dep, field_dep);
    var nid = dom_node.id || (dom_node.id = ('m'+next_id++)); // TODO: new id each respawn!
    add_handler('t'+nid, function() {
      // the currently selected vnode (scope) is saved on the field_dep so we can
      // un-select it when another vnode becomes selected (TODO: replace with a binding?)
      var old_sel = field_dep.tap_sel_current;
      if (old_sel !== scope) {
        if (old_sel) {
          var old_dom = old_sel.dom;
          if (old_dom) remove_class(old_dom, field_dep.tap_sel_cls);
        }
        // make this element the selected element.
        // sample the value of expr_dep and copy it to field_dep (set the selected value)
        field_dep.val = expr_dep.val;
        field_dep.tap_sel_current = scope;
        field_dep.tap_sel_cls = cls;
        mark_dirty(field_dep);
        add_class(dom_node, cls); // should be done with a binding?
      }
    });
    // TODO: append unbind func to the scope.
  }

  function attr_submit_to(dom_node, scope) {
    // applied to Form elements: submit the form data to a Model's `submit` action.
    p += 1;
    var expr_dep = resolve_expr(scope);
    dom_node.addEventListener('submit', function(event) {
      var model = (expr_dep instanceof Model) ? expr_dep : (expr_dep && expr_dep.val), submit;
      if (model && typeof (submit=model['submit']) === 'function') {
        event.preventDefault();
        var data = {};
        // TODO: clean this up - quick code to gather form data...
        // TODO: textarea, select with multiple=true, list and number types.
        var els = dom_node['elements'];
        if (els) {
          for (var i=0, n=els.length; i<n; i++) {
            var inp = els[i], name = inp.name, value = inp.value;
            if (name && value != null) {
              data[name] = value;
            } else if (name && inp instanceof HTMLSelectElement) {
              data[name] = inp.selectedIndex >= 0 ? inp[inp.selectedIndex].value : null;
            }
          }
        }
        submit(model, data);
      }
    }, false);
  }

  var attr_ops = [
    attr_literal_text,  // 0
    attr_literal_bool,  // 1
    attr_bound_text,    // 2
    attr_bound_bool,    // 3
    attr_literal_class, // 4
    attr_bound_class,   // 5
    attr_cond_class,    // 6
    attr_bound_style,   // 7
    attr_tap_sel,       // 8
    attr_submit_to,     // 9
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
      if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
      dep.fwd.push(watch);
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
    var dom_node = document.createElement(tag);
    dom_scope.dom = dom_node; // dom_scope owns dom_node.
    var nattrs = tpl[p++];
    var cls = [];
    // apply attributes and bindings (grouped by type)
    while (nattrs--) {
      attr_ops[tpl[p]](dom_node, dom_scope, cls);
    }
    // must append, because attr_bound_class and attr_cond_class can update first.
    if (cls.length) dom_node.className += cls.join(' ');
    // spawn any child scopes inside this dom_scope.
    spawn_child_scopes(dom_scope, dom_node);
    // always build dom sub-trees by appending inside a document fragment.
    append_to.appendChild(dom_node);
  }

  function create_component(up_scope, append_to) {
    var tpl_id = tpl[p];
    var content_tpl = tpl[p+1];
    var nbinds = tpl[p+2];
    p += 3;
    if (log_spawn) console.log("[s] create component:", tpl_id, content_tpl, nbinds);
    // component has its own scope because it has its own namespace for bound names,
    // but doesn't have an independent lifetime (destroyed with the parent scope)
    var com_scope = new_scope(up_scope, content_tpl); // pass in the instance `contents`.
    com_scope.binds = {};
    for (var i=0; i<nbinds; i++) {
      var name = sym_list[tpl[p++]]; // TODO: flatten scopes into vectors (i.e. remove names)
      var dep = resolve_expr(up_scope);
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
        // Cannot run spawn code inside a dep update transaction (due to dep.fwd.push)
        // Better to queue scopes for an update, and have them create all their contents against
        // deps in the `ready` state: can use dep vals immediately, and avoids second DOM update.
        dep_upd_queue_spawn(dep.body_tpl, dep.cond_scope);
      }
    } else {
      if (dep.in_doc) {
        dep.in_doc = false;
        // Cannot clear scopes inside a dep update transaction (due to dep.fwd changes)
        dep_upd_queue_reset(dep.cond_scope);
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
    if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
    if (src_dep.wait >= 0) src_dep.fwd.push(cond_dep); // subscribe.
    dep_upd_condition(cond_dep, append_to); // update now in `append_to` mode.
  }

  function dep_upd_queue_spawn(body_tpl, inst_scope) {
    // FIXME: proof of concept: defer spawn code until after the dep update transaction has finished.
    // Instead of this, mark the scope and push it to a queue that runs at `in_transaction = null`
    // Note that (in theory) a scope can flip between `to-spawn` and `to-reset` multiple times.
    setTimeout(function(){
      spawn_tpl(body_tpl, inst_scope);
    },0);
  }

  function dep_upd_queue_reset(inst_scope) {
    // FIXME: proof of concept: defer reset until after the dep update transaction has finished.
    // Instead of this, mark the scope and push it to a queue that runs at `in_transaction = null`
    // Note that (in theory) a scope can flip between `to-spawn` and `to-reset` multiple times.
    setTimeout(function(){
      reset_scope(inst_scope);
    },0);
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
        // Cannot run spawn code inside a dep update transaction (due to dep.fwd.push)
        // Better to queue scopes for an update, and have them create all their contents against
        // deps in the `ready` state: can use dep vals immediately, and avoids second DOM update.
        dep_upd_queue_spawn(body_tpl, inst_scope); // closure for loop.
      }
      new_keys[key] = inst_scope;
    }
    dep.have_keys = new_keys;
    // destroy all remaining unused child scopes.
    while (next_scope) {
      var after = next_scope.next_s; // capture before unlink.
      unlink(rep_scope, next_scope);
      // Cannot clear scopes inside a dep update transaction (due to dep.fwd changes)
      dep_upd_queue_reset(next_scope); // closure for loop.
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
    if (in_transaction) throw 2; // assert: cannot fwd.push inside a transaction.
    if (src_dep.wait >= 0) src_dep.fwd.push(rep_dep); // subscribe.
    dep_upd_repeat(rep_dep, append_to); // update now in `append_to` mode.
  }

  function dep_bind_to_hash_change(dep) {
    // closure to capture `dep` for `hashchange` event.
    addEventListener('hashchange', function(){ set_dep(dep, location.hash); }, false);
  }

  function create_router(scope) {
    // Create a Router Controller in the local scope.
    var bind_as = sym_list[tpl[p++]];
    var router = new Model(bind_as);
    scope.binds[bind_as] = router;
    var route_dep = mkdep(location.hash); // dep.
    if (debug) route_dep._nom = 'route';
    router._deps['route'] = route_dep;
    dep_bind_to_hash_change(route_dep); // avoids capturing doc, dom_parent, etc.
  }

  function act_auth_submit(auth, data) {
    // TODO: messy, uses public deps.
    if (debug) console.log("SUBMIT:", data);
    set_dep(auth._deps['submitting'], true);
    set_dep(auth._deps['error'], false);
    postJson(auth.auth_url, '', data, function (code, data) {
      if (debug) console.log("manglr: authenticate:", auth.auth_url, code, data);
      set_dep(auth._deps['submitting'], false);
      if (code === 200 && data) {
        data = data.d || data || {}; // unwrap quirky json.
        var token = data[auth.token_path];
        if (token) {
          set_dep(auth.token_dep, token);
          set_dep(auth._deps['auth_required'], false);
        } else {
          set_dep(auth._deps['error'], true);
        }
      } else {
        set_dep(auth._deps['error'], true);
      }
    });
  }

  function create_auth(scope) {
    // Create an Authentication controller in the local scope.
    var bind_as = sym_list[tpl[p++]];
    var auth_url = sym_list[tpl[p++]];
    var token_path = sym_list[tpl[p++]];
    var auth = new Model(bind_as);
    auth.auth_url = auth_url;
    auth.token_path = token_path;
    var ss = window.localStorage;
    var token = (ss && ss.getItem && ss.getItem(bind_as)) || '';
    auth.token_dep = mkdep(token);
    scope.binds[bind_as] = auth;
    var auth_required = mkdep(!token);
    if (debug) auth_required._nom = 'auth_required';
    auth._deps['auth_required'] = auth_required;
    auth._deps['submitting'] = mkdep(false);
    auth._deps['error'] = mkdep(false);
    auth.submit = act_auth_submit;
  }

  function mkdep(val, fn, arg) {
    return { val:val, wait:0, fwd:[], dirty:false, fn:(fn||null), arg:(arg||null) };
  }

  function set_dep(dep, val) {
    if (dep.val !== val) {
      dep.val = val;
      mark_dirty(dep);
    }
  }

  function copy_dep_and_watch(src, src_name, dest, dest_name, watcher) {
    // Copy a dep from one object (or null) to another and update a watcher dep's subscription.
    // TODO: messy; can dep following be done without so much indirection?
    var new_dep = src ? src[src_name] : null;
    var old_dep = dest[dest_name];
    if (new_dep != old_dep) { // null == undefined.
      if (old_dep) unsubscribe_dep(old_dep, watcher);
      dest[dest_name] = new_dep;
      if (new_dep) subscribe_dep(new_dep, watcher); // will update watcher.
    }
  }

  function act_store_reload(store) {
    // TODO: not linked up to anything yet.
    set_dep(store.state_dep, 0); // transition to 0=loading state.
  }

  function load_store_items(store, token) {
    var url = store.get_url.val;
    postJson(url, token, {}, function (code, data) {
      if (debug) console.log("manglr: store fetch: "+url, code, data);
      if (code === 200 && data) {
        data = data.d || data || {}; // unwrap quirky json.
        var items = null;
        if (data instanceof Array) items = data;
        else if (data['items'] instanceof Array) items = data['items']; // TODO: option (a path)
        if (items) {
          set_dep(store.items_dep, items || []);
          set_dep(store.state_dep, 2); // 2=loaded.
        } else {
          set_dep(store.state_dep, 1); // 1=error.
        }
      } else {
        set_dep(store.state_dep, 1); // 1=error.
      }
    });
  }

  function dep_upd_store_watcher(dep) {
    var store = dep.arg; // Model from create_store.
    if (store.state_dep.val === 0) {
      // in "loading" state.
      var token_dep = store.token_dep;
      var token = token_dep ? token_dep.val : '';
      if (!token_dep || token) {
        // no auth requried, or have auth token.
        load_store_items(store, token);
      } else if (token_dep) {
        // put the auth model into `auth_required` state.
        // TODO: messy, uses public deps. use some kind of interface test?
        var auth, deps, req;
        if ((auth=store.auth) && (deps=auth._deps) && (req=deps['auth_required'])) {
          set_dep(req, true);
        }
      }
    }
  }

  function dep_upd_store_loading(dep, store) { dep.val = (store.state_dep.val === 0); }
  function dep_upd_store_error(dep, store) { dep.val = (store.state_dep.val === 1); }
  function dep_upd_store_loaded(dep, store) { dep.val = (store.state_dep.val === 2); }

  function dep_upd_store_auth(dep) {
    // when the `auth` expr changes, must subscribe to the new token_dep.
    // following the `token_dep` avoids the need to queue pending requests.
    // FIXME: very much an edge case, and adds considerable complexity.
    var src_dep = dep.val;
    var store = dep.arg;    // Model from create_store.
    var auth = src_dep.val; // new `auth` model or `null`.
    store.auth = auth;
    copy_dep_and_watch(auth, 'token_dep', store, 'token_dep', store.watcher);
  }

  function create_store(scope) {
    // Create a Store instance in the local scope.
    var bind_as = sym_list[tpl[p++]];
    var store = new Model(bind_as);
    store.get_url = resolve_expr(scope);
    var auth = resolve_expr(scope); // TODO: always a Model, or can be a Dep → Model ?
    if (debug) console.log("> STORE", bind_as, store.get_url, auth);
    var state_dep = mkdep(0); // 0=loading
    var items_dep = mkdep([]);
    store.state_dep = state_dep;
    store.items_dep = items_dep;
    var deps = store._deps;
    deps['items'] = items_dep;
    deps['loading'] = mkdep(true, dep_upd_store_loading, store);
    deps['error'] = mkdep(false, dep_upd_store_error, store);
    deps['loaded'] = mkdep(false, dep_upd_store_loaded, store);
    scope.binds[bind_as] = store;
    // trigger load when token is ready and state == 0 (loading)
    // TODO: could use state_dep as the watcher dep.
    var watcher = mkdep(false, dep_upd_store_watcher, store);
    store.watcher = watcher;
    state_dep.fwd.push(watcher); // trigger on state change.
    // TODO: messy, not happy about all this complexity.
    if (auth instanceof Model) {
      if (debug) console.log(".. auth is a model");
      store.auth = auth;
      store.token_dep = auth.token_dep;
      if (store.token_dep) store.token_dep.fwd.push(watcher); // trigger on token change.
      dep_upd_store_watcher(watcher); // update watcher now.
    } else if (auth) {
      // auth is a dep: must follow its changes.
      if (debug) console.log(".. auth is a dep");
      var auth_follow = mkdep(auth, dep_upd_store_auth, store); // auth.token_dep → watcher.
      auth.fwd.push(auth_follow);
      dep_upd_store_auth(auth_follow); // update now → will update watcher.
    }
  }

  function create_model(scope) {
    // Create a Model instance in the local scope.
    var bind_as = sym_list[tpl[p++]];
    if (debug) console.log("> MODEL "+bind_as);
    var model = new Model(bind_as);
    var deps = model._deps;
    scope.binds[bind_as] = model;
  }

  var dom_create = [
    create_text,       // 0  text
    create_bound_text, // 1  text
    create_element,    // 2  element
    create_component,  // 3  scope
    create_condition,  // 4  scope
    create_repeat,     // 5  scope
    create_model,      // 6  <model>
    create_store,      // 7  <store>
    create_router,     // 8  <router>
    create_auth,       // 9  <authentication>
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
