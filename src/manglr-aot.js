"use strict";

const log_new = false;
const log_out = false;

const path = require('path');
const fs = require('fs');
const html_parser = require('../third-party/node-html-parser');
const std_attr = new RegExp("^accept-charset$|^http-equiv$|^data-|^aria-");
const hasOwn = Object.prototype.hasOwnProperty;
const builtins = {};   // registry.
const directives = {}; // registry.
const prefixes = {};   // registry.
const mod_conds = {};  // registry.
var prefix_re = null;
var next_tpl_id = 2; // 0 = empty template, 1 = root template.
var prefixes_dirty = true;
const root_component = { id:1, tpl:[], tags:{}, dom_node:null, tag:'$', parent:null };
const comp_list = [root_component];
const bool_attr = "allowFullscreen|async|autofocus|autoplay|checked|compact|controls|declare|default|defaultChecked|defaultMuted|defaultSelected|defer|disabled|draggable|enabled|formNoValidate|hidden|indeterminate|inert|isMap|itemScope|loop|multiple|muted|noHref|noResize|noShade|noValidate|noWrap|open|pauseOnExit|readOnly|required|reversed|scoped|seamless|selected|sortable|spellcheck|translate|trueSpeed|typeMustMatch|visible";
const bool_map = {};
for (var k, s=bool_attr.split('|'), i=0; i<s.length; i++) { k=s[i]; bool_map[k.toLowerCase()]=k; }

// ---- build dom ----

function parse_html(source) {
  return html_parser.parse(source, {lowerCaseTagName:true, script:true, noscript:true, style:true, pre:true});
}

// ---- error reporting ----

const error_msgs = [
  '',                                                                     // 0
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
  'no handler registered for modular condition named "@"',                // 14
  'component requires an "@" attribute',                                  // 15
  'component "@" cannot be conditional or repeated',                      // 16
  'component "@" cannot have any child elements',                         // 17
  'tap-select: incorrect syntax.\n  expecting: "(expr) in (model.field) [ class (class-name) ] [ auto ]",\n  but found: "@"\n  in tag:', // 18
  'inline stylesheet: file not found: "@"',                               // 19
  'component attribute "@" cannot include {expr} placeholders',           // 20
];

const log = console.log;

function error(node, n, name, err) {
  if (node instanceof NodeProxy) node = node._node; // use the DOM node.
  const tag = node.tagString; // opening tag only.
  console.log('manglr: '+(error_msgs[n]||n).replace(/@/g,name), tag, err ? err : '');
}


// ---- Encoder Symbol Table ----

const sym_list = [];
const sym_map = new Map();

function sym(name) {
  // look up or register a new symbol.
  var idx = sym_map.get(name);
  if (idx != null) return idx;
  idx = sym_list.length;
  sym_list.push(name);
  sym_map.set(name, idx);
  return idx;
}


// ---- Structural AST Nodes ----

// first build AST nodes describing the tree to compile (plugins can contribute)
// then encode those nodes, resolving tag names and scope names during traversal.

function create_tpl(contents) {
  if (!contents.length) return 0; // the empty template.
  var tpl_id = next_tpl_id++;
  // looks like a component, but only 'tpl' is used for encoding.
  var comp = { id:tpl_id, tpl:contents };
  comp_list.push(comp);
  return tpl_id;
}

function encode_named_nodes(tpl, binds) {
  // HACK : convert from attr_ops to expr_ops ...
  var pairs = [];
  for (var i=0; i<binds.length; i++) {
    var b = binds[i];
    if (b instanceof LiteralText) pairs.push(b.name, new ConstText(b.value));
    else if (b instanceof BoundText) pairs.push(b.name, b.expr);
    else throw "cannot encode Attribute Binding as an expression";
  }
  // encode the { name, expr } pairs.
  tpl.push(pairs.length/2);
  for (var i=0; i<pairs.length; i += 2) {
    tpl.push(sym(pairs[i])); // name of the node.
    pairs[i+1].encode(tpl);  // encode the node.
  }
}

const dom_ops = {
  text:            0,
  bound_text:      1,
  element:         2,
  component:       3,
  condition:       4,
  repeat:          5,
  model:           6,
  store:           7,
  router:          8,
  authentication:  9,
};

function DomText(text) {
  // Literal text inside a DOM Element.
  this.text = text;
}
DomText.prototype.encode = function (tpl) {
  tpl.push(dom_ops.text, sym(this.text));
};

function DomBoundText(expr) {
  // Bound text expression inside a DOM Element.
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
DomBoundText.prototype.encode = function (tpl) {
  // TODO: reduce here and encode as DomText if const?
  tpl.push(dom_ops.bound_text);
  this.expr.encode(tpl);
};

function DomTag(name, binds, contents) {
  this.name = name;
  this.binds = binds;
  this.contents = contents;
}
DomTag.prototype.encode = function (tpl) {
  tpl.push(dom_ops.element, sym(this.name), this.binds.length);
  this.binds.forEach(n => n.encode(tpl)); // reduce and encode each binding.
  tpl.push(this.contents.length);
  this.contents.forEach(n => n.encode(tpl)); // reduce and encode contents.
};

function DomComponent(name, cid, binds, contents) {
  this.name = name;
  this.cid = cid;
  this.binds = binds;
  this.content_tpl = create_tpl(contents); // must reserve tpl slot before encoding begins.
}
DomComponent.prototype.encode = function (tpl) {
  // need to resolve components before encode to determine which ones are used?
  // var comp = scope.c_tags[this.name];
  // if (!comp) error(this.node, 'no component found (in scope) for custom tag "'+this.name+'"');
  tpl.push(dom_ops.component, this.cid, this.content_tpl);
  encode_named_nodes(tpl, this.binds);
};

function CondNode(expr, contents) {
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
  this.tpl_id = create_tpl(contents); // must reserve tpl slot before encoding begins.
}
CondNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.condition, this.tpl_id);
  this.expr.encode(tpl);
};

function RepeatNode(bind_as, expr, contents) {
  this.bind_as = bind_as;
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
  this.tpl_id = create_tpl(contents); // must reserve tpl slot before encoding begins.
}
RepeatNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.repeat, sym(this.bind_as), this.tpl_id);
  this.expr.encode(tpl);
};

function RouterNode(bind_as) {
  this.bind_as = bind_as;
}
RouterNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.router, sym(this.bind_as));
};

function AuthenticationNode(bind_as, auth_url, token_path) {
  this.bind_as = bind_as;
  this.auth_url = auth_url;
  this.token_path = token_path;
}
AuthenticationNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.authentication, sym(this.bind_as), sym(this.auth_url), sym(this.token_path));
};

function ModelNode(bind_as) {
  this.bind_as = bind_as;
}
ModelNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.model, sym(this.bind_as));
};

function StoreNode(bind_as, get_url, auth_ref) {
  this.bind_as = bind_as;
  this.get_url = get_url;
  this.auth_ref = auth_ref;
  if (!get_url instanceof Expr) throw "bad get_url";
  if (!auth_ref instanceof Expr) throw "bad auth_ref";
}
StoreNode.prototype.encode = function (tpl) {
  tpl.push(dom_ops.store, sym(this.bind_as));
  this.get_url.encode(tpl);
  this.auth_ref.encode(tpl);
};


// ---- Attribute AST Nodes ----

const attr_ops = {
  literal_text:      0,
  literal_bool:      1,
  bound_text:        2,
  bound_bool:        3,
  literal_class:     4,
  bound_class:       5,
  cond_class:        6,
  bound_style:       7,
  tap_sel:           8,
  submit_to:         9,
};

function LiteralText(name, value) {
  // Attribute with literal text value.
  this.name = name;
  this.value = value;
}
LiteralText.prototype.encode = function (tpl) {
  tpl.push(attr_ops.literal_text, sym(this.name), sym(this.value));
};

function LiteralBool(name, value) {
  this.name = name;
  this.value = value;
}
LiteralBool.prototype.encode = function (tpl) {
  tpl.push(attr_ops.literal_bool, sym(this.name), this.value ? 1 : 0);
};

function BoundText(name, expr) {
  // Attribute bound to a text expression.
  this.name = name;
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
BoundText.prototype.encode = function (tpl) {
  tpl.push(attr_ops.bound_text, sym(this.name));
  this.expr.encode(tpl);
};

function BoundBool(name, expr) {
  this.name = name;
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
BoundBool.prototype.encode = function (tpl) {
  tpl.push(attr_ops.bound_bool, sym(this.name));
  this.expr.encode(tpl);
};

function LiteralClass(name) {
  this.name = name;
}
LiteralClass.prototype.encode = function (tpl) {
  tpl.push(attr_ops.literal_class, sym(this.name));
};

function BoundClass(expr) {
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
BoundClass.prototype.encode = function (tpl) {
  tpl.push(attr_ops.bound_class);
  this.expr.encode(tpl);
};

function CondClass(name, expr) {
  this.name = name;
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
CondClass.prototype.encode = function (tpl) {
  tpl.push(attr_ops.cond_class, sym(this.name));
  this.expr.encode(tpl);
};

function BoundStyle(name, expr) {
  this.name = name;
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
BoundStyle.prototype.encode = function (tpl) {
  tpl.push(attr_ops.bound_style, sym(this.name));
  this.expr.encode(tpl);
};

function TapSelect(cls, expr, field) {
  this.cls = cls;
  this.expr = expr;
  this.field = field;
  if (!expr instanceof Expr) throw "bad expr";
}
TapSelect.prototype.encode = function (tpl) {
  tpl.push(attr_ops.tap_sel, sym(this.cls));
  this.expr.encode(tpl);
  this.field.encode(tpl);
};

function SubmitTo(expr) {
  this.expr = expr;
  if (!expr instanceof Expr) throw "bad expr";
}
SubmitTo.prototype.encode = function (tpl) {
  tpl.push(attr_ops.submit_to);
  this.expr.encode(tpl);
};


// ---- Expression AST Nodes ----

const expr_ops = {
  const_text:     0,
  const_num:      1,
  scope_lookup:   2,
  concat_text:    3,
  equals:         4,
  not_op:         5,
  add:            6,
  sub:            7,
  mul:            8,
  div:            9,
};

function Expr() {} // base interface for expr_ops.

function ConstText(text) {
  this.value = text;
}
ConstText.prototype = new Expr();
ConstText.prototype.encode = function (tpl) {
  tpl.push(expr_ops.const_text, sym(this.value));
};

function ScopeLookup(path) {
  this.path = path;
}
ScopeLookup.prototype = new Expr();
ScopeLookup.prototype.encode = function (tpl) {
  if (this.path.length < 1) throw new Error("empty path in ScopeLookup node");
  tpl.push(expr_ops.scope_lookup, this.path.length);
  Array.prototype.push.apply(tpl, this.path.map(sym));
};

function ConcatText(args) {
  this.args = args;
}
ConcatText.prototype = new Expr();
ConcatText.prototype.encode = function (tpl) {
  if (this.args.length < 1) this.args.push(new ConstText(""));
  tpl.push(expr_ops.concat_text, this.args.length);
  this.args.forEach(n => n.encode(tpl));
};

function EqualsOp(left, right) {
  this.left = left;
  this.right = right;
}
EqualsOp.prototype = new Expr();
EqualsOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.equals);
  this.left.encode(tpl);
  this.right.encode(tpl);
};

function NotOp(right) {
  this.right = right;
}
NotOp.prototype = new Expr();
NotOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.not_op);
  this.right.encode(tpl);
};

function AddOp(left, right) {
  this.left = left;
  this.right = right;
}
AddOp.prototype = new Expr();
AddOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.add);
  this.left.encode(tpl);
  this.right.encode(tpl);
};

function SubOp(left, right) {
  this.left = left;
  this.right = right;
}
SubOp.prototype = new Expr();
SubOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.sub);
  this.left.encode(tpl);
  this.right.encode(tpl);
};

function MulOp(left, right) {
  this.left = left;
  this.right = right;
}
MulOp.prototype = new Expr();
MulOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.mul);
  this.left.encode(tpl);
  this.right.encode(tpl);
};

function DivOp(left, right) {
  this.left = left;
  this.right = right;
}
DivOp.prototype = new Expr();
DivOp.prototype.encode = function (tpl) {
  tpl.push(expr_ops.div);
  this.left.encode(tpl);
  this.right.encode(tpl);
};

// ---- API for directives ----

function NodeProxy(node, tpl) {
  this._node = node;
  this._tpl = tpl; // null for HTML tags.
  this._binds = [];
  this._bound = new Map();
  this._conds = [];
  this._repeats = [];
  this._children = [];
  this._ended = false;
}
NodeProxy.prototype.expr = function (src) {
  // parse an expression in the scope of this node.
  if (this._ended) throw new Error("expr(src) too late to modify this node");
  if (typeof(src) !== 'string') throw new Error("expr(src) the `src` must be a string");
  return parse_expr(src);
};
NodeProxy.prototype.text_tpl = function (text) {
  // parse an expression in the scope of this node.
  if (this._ended) throw new Error("text_tpl(text) too late to modify this node");
  if (typeof(text) !== 'string') throw new Error("text_tpl(text) the `text` must be a string");
  return parse_text_tpl_as_expr(text);
};
NodeProxy.prototype.cond_expr = function (src) {
  // parse a modular condition or boolean expression in the scope of this node.
  if (this._ended) throw new Error("cond_expr(src) too late to modify this node");
  if (typeof(src) !== 'string') throw new Error("cond_expr(src) the `src` must be a string");
  mod_con_re.lastIndex = 0;
  var mod_con = mod_con_re.exec(src);
  if (mod_con) {
    var cond_name = mod_con[1], tail = mod_con[2];
    var handler = mod_conds[cond_name];
    if (handler) {
      return handler(this, tail);
    } else {
      error(this._node, 14, cond_name); // debugging: report unknown modular condition.
      return new ConstText("");
    }
  } else {
    // TODO: validate as a boolean expression.
    return parse_expr(src);
  }
};
NodeProxy.prototype.equals = function (left, right) {
  // create an operation that compares expressions.
  if (this._ended) throw new Error("equals(left, right) too late to modify this node");
  if (!(left instanceof Expr)) throw new Error("equals(left, right) the `left` must be an instance of Expr");
  if (!(right instanceof Expr)) throw new Error("equals(left, right) the `right` must be an instance of Expr");
  return new EqualsOp(left, right);
};
NodeProxy.prototype.not = function (right) {
  // create an operation that compares expressions.
  if (this._ended) throw new Error("equals(left, right) too late to modify this node");
  if (!(right instanceof Expr)) throw new Error("equals(left, right) the `right` must be an instance of Expr");
  return new NotOp(right);
};
NodeProxy.prototype.cond = function (expr) {
  // add a condition to the node (i.e. wrap it in a condition)
  if (this._ended) throw new Error("cond(expr) too late to modify this node");
  if (!(expr instanceof Expr)) throw new Error("cond(expr) the `expr` must be an instance of Expr");
  this._conds.push(expr);
};
NodeProxy.prototype.repeat = function(expr, name) {
  // repeat this node (i.e. wrap it in a repeating element)
  if (this._ended) throw new Error("repeat(expr, name) too late to modify this node");
  if (!(expr instanceof Expr)) throw new Error("repeat(expr, name) the `expr` must be an instance of Expr");
  if (typeof(name) !== 'string') throw new Error("repeat(expr, name) the `name` must be a string");
  this._repeats.push(expr, name);
};
NodeProxy.prototype.add_class = function (name) {
  // add a literal class name to the node.
  if (this._ended) throw new Error("add_class(name) too late to modify this node");
  if (typeof(name) !== 'string') throw new Error("add_class(name) the `name` must be a string");
  if (this._tpl) throw new Error("add_class(name) cannot add a class to a custom component tag");
  var names = name.split(/\s+/g);
  for (var c=0; c<names.length; c++) {
    var cls = names[c];
    if (cls) this._binds.push(new LiteralClass(cls));
  }
};
NodeProxy.prototype.cond_class = function (name, expr) {
  // bind (the presence of) a class name to a boolean expression.
  if (this._ended) throw new Error("cond_class(name, expr) too late to modify this node");
  if (typeof(name) !== 'string') throw new Error("cond_class(name, expr) the `name` must be a string");
  if (!(expr instanceof Expr)) throw new Error("cond_class(name, expr) the `expr` must be an instance of Expr");
  if (this._tpl) throw new Error("cond_class(name, expr) cannot add a class to a custom component tag");
  this._binds.push(new CondClass(name, expr));
};
NodeProxy.prototype.bind_style = function (name, expr) {
  // bind (the presence of) a class name to a boolean expression.
  if (this._ended) throw new Error("bind_style(name, expr) too late to modify this node");
  if (typeof(name) !== 'string') throw new Error("bind_style(name, expr) the `name` must be a string");
  if (!(expr instanceof Expr)) throw new Error("bind_style(name, expr) the `expr` must be an instance of Expr");
  if (this._tpl) throw new Error("cond_class(name, expr) cannot add a style to a custom component tag");
  this._binds.push(new BoundStyle(name, expr));
};
NodeProxy.prototype.bind_attr = function (name, expr) {
  // bind an attribute on this node to an expression.
  if (this._ended) throw new Error("bind_attr(name, expr) too late to modify this node");
  if (typeof(name) !== 'string') throw new Error("bind_attr(name, expr) the `name` must be a string");
  if (!(expr instanceof Expr)) throw new Error("bind_attr(name, expr) the `expr` must be an instance of Expr");
  if (this._bound.has(name)) { error(this._node, 21, name); return; }
  this._bound.set(name, expr);
  // TODO: should defer this until we know it's a HTML tag.
  if (!this._tpl && hasOwn.call(bool_map, name)) {
    // bind to a boolean property on an HTML DOM element.
    if (expr instanceof ConstText) {
      this._binds.push(new LiteralBool(bool_map[name], !!expr.value));
    } else {
      this._binds.push(new BoundBool(bool_map[name], expr));
    }
  } else {
    if (expr instanceof ConstText) {
      this._binds.push(new LiteralText(name, expr.value));
    } else {
      this._binds.push(new BoundText(name, expr));
    }
  }
};
NodeProxy.prototype.implicit = function (name, path) {
  // look up an implicit argument in the scope of this node.
  if (this._ended) throw new Error("implicit(name, path) too late to modify this node");
  if (typeof(name) !== 'string') throw new Error("implicit(name, path) the `name` must be a string");
  if (typeof(path) !== 'string') throw new Error("implicit(name, path) the `path` must be a string");
  // TODO: introduce an implicit "in" binding up through enclosing scopes until we reach a template.
  // Quick hack: look it up in the scope, which links all the way to the root scope (!!)
  return parse_expr(name+'.'+path);
};
NodeProxy.prototype.add_children = function (children) {
  Array.prototype.push.apply(this._children, children);
};


// ---- built-in components ----

function find_bound(proxy, name) {
  const bound = proxy._bound.get(name);
  if (bound) return bound;
  error(proxy._node, 15, name); // missing binding.
  return null;
}

function find_literal_text(proxy, name) {
  const bound = find_bound(proxy, name);
  if (bound && !(bound instanceof ConstText)) {
    error(proxy._node, 20, name); // must be literal.
    return null;
  }
  return bound.value; // text content.
}

builtins['router'] = function (node, proxy, comp_ctls) {
  if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, 'router'); return; }
  if (proxy._children['length']) { error(node, 17, 'router'); return; } // TODO: ignore DomText whitespace.
  if (log_new) log("[ ROUTER:", proxy);
  var id = find_literal_text(proxy, 'name');
  if (!id) return null;
  comp_ctls.push(new RouterNode(id));
  return null; // no out_node.
};

builtins['authentication'] = function (node, proxy, comp_ctls) {
  if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, 'authentication'); return; }
  if (log_new) log("[ AUTHENTICATION:", proxy);
  var id = find_literal_text(proxy, 'name'); if (!id) return null;
  var auth_url = find_literal_text(proxy, 'api'); if (!auth_url) return null;
  var tok_path = find_literal_text(proxy, 'ret'); if (!tok_path) return null;
  comp_ctls.push(new AuthenticationNode(id, auth_url, tok_path));
  // leave the authentication contents in-place, but wrap in a condition node.
  var out_node = null;
  if (proxy._children.length) {
    var auth_expr = proxy.implicit(id, 'auth_required');
    out_node = new CondNode(auth_expr, proxy._children);
  }
  return out_node;
};

builtins['model'] = function (node, proxy, comp_ctls) {
  if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, 'model'); return; }
  if (proxy._children['length']) { error(node, 17, 'model'); return; } // TODO: ignore DomText whitespace.
  if (log_new) log("[ MODEL:", proxy);
  var id = find_literal_text(proxy, 'name');
  if (!id) return null;
  comp_ctls.push(new ModelNode(id));
  return null; // no out_node.
};

builtins['store'] = function (node, proxy, comp_ctls) {
  if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, 'store'); return; }
  if (proxy._children['length']) { error(node, 17, 'store'); return; } // TODO: ignore DomText whitespace.
  if (log_new) log("[ STORE:", proxy);
  var id = find_literal_text(proxy, 'name');
  var get_url = find_bound(proxy, 'get'); // text tpl, can include {expr}
  var auth_ref = parse_expr(find_literal_text(proxy, 'auth')); // TODO: must be a valid path.
  if (!(id && get_url && auth_ref)) return;
  comp_ctls.push(new StoreNode(id, get_url, auth_ref));
  return null; // no out_node.
};


// ---- modular conditions ----

mod_conds['route'] = function (node, rest) {
  if (log_new) log("[ ROUTE COND:", rest, node);
  var route = node.implicit('@router', 'route');
  // TODO: need to trim `rest` before matching - text tpl can contain whitespace.
  return node.equals(route, node.text_tpl(rest));
};


// ---- directives ----

directives['if'] = function (node, value) {
  if (log_new) log("[ IF:", value, node);
  // - compile the expression in the scope of `node`
  // - wrap the node in a condition node.
  node.cond(node.cond_expr(value));
};

directives['repeat'] = function (node, value) {
  if (log_new) log("[ REPEAT:", value, node);
  // - compile the expression in the scope of the inner nodes [repeat creates its own scopes]
  // - wrap the inner nodes in a condition node.
  var args = value.split(' from ');
  if (args.length !== 2) throw new Error('incorrect syntax - must be repeat="{expr} as name"');
  var name = args[0];
  var expr = args[1]+'.items';
  node.repeat(node.expr(expr), name);
};

directives['if-route'] = function (node, value) {
  if (log_new) log("[ IF-ROUTE:", value, node);
  var route = node.implicit('@router', 'route');
  // TODO: need to trim `value` before matching - text tpl can contain whitespace.
  node.cond(node.equals(route, node.text_tpl(value)));
};

directives['class'] = function (node, value) {
  // Must special-case "class" to merge with "class-" prefix directives.
  var classes = parse_text_tpl(value);
  for (var expr of classes) {
    if (expr instanceof ConstText) {
      node.add_class(expr.value);
    } else {
      // bound class: resolves to the name of a class (or multiple classes)
      node._binds.push(new BoundClass(expr));
    }
  }
};

directives['style'] = function (node, value) {
  // Must special-case "style" to merge with "style-" prefix directives.
  log("TODO: parse the 'style' attribute");
  node.bind_attr('style', node.text_tpl(value)); // bind as a text attribute for now.
};

directives['tap-select'] = function (node, value) {
  // Makes an Element selectable; adds class "selected" when selected.
  // assigns the value of [expr] to the specified model field when selected,
  // and uses the current value of the model field to determine selected status.
  // syntax: (expr) in (model.field) [ class (class-name) ] [ auto ]
  const match = value.match(/^\s*(.+)\s+in\s+(\S+)(?:\s+class\s+(\S+))?(?:\s+auto)?\s*(.*)$/);
  if (match) {
    const [_, expr, field, cls, ex] = match;
    if (ex) {
      error(node, 18, value);
    } else {
      if (!cls) cls = 'selected';
      log("[ TAP-SELECT:", expr, field, cls, ex);
      var c_expr = parse_expr(expr);
      var c_field = parse_expr(field);
      node._binds.push(new TapSelect(cls, c_expr, c_field));
    }
  } else {
    error(node, 18, value);
  }
};

directives['submit-to'] = function (node, value) {
  // Make a <form> submit its input values to a component's `submit` action.
  // TODO: should it accept an action instead? (i.e. to perform with implicit data from the form)
  var c_target = parse_expr(value);
  node._binds.push(new SubmitTo(c_target));
};


// ---- prefix handlers ----

prefixes['class-'] = function(node, value, name) {
  if (log_new) log("[ CLASS:", name, value, node);
  node.cond_class(name, node.cond_expr(value));
};

prefixes['style-'] = function(node, value, name) {
  if (log_new) log("[ STYLE:", name, value, node);
  node.bind_style(name, node.expr(value));
};


// ---- parsing components ----

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

const tpl_re = new RegExp("([^{]*){?([^}]*)}?", "y");
const mod_con_re = new RegExp("\\s*([A-Za-z][-A-Za-z0-9_]*):\\s*(.*)", "y"); // "cond-name: (expr)"
const expr_re = new RegExp("(\\s+)|([@A-Za-z][A-Za-z0-9_.]*)|(:=|.)", "y"); // (?:\\.\\w[\\w\\d_]*)*
const norm_re = new RegExp("\\s+", "g")

function norm_ws(text) {
  return text.replace(norm_re, " ");
}

const dy_ops = {
  '+': AddOp,
  '-': SubOp,
  '*': MulOp,
  '/': DivOp,
};

// some tentative parser stuff that needs to be re-written properly...

function nud_expr(text, aft_op) {
  for (;;) {
    var pos = expr_re.lastIndex;
    var match = expr_re.exec(text);
    log("nud_expr:", JSON.stringify(match));
    if (!match) {
      if (aft_op) log(`manglr: expecting an operand after operator '${aft_op}', but found nothing, in expression: '${text}' at position ${pos}`);
      else log(`manglr: expecting an expression, but found nothing, in expression: '${text}' at position ${pos}`);
      return new ConstText("");
    }
    if (match[1]) continue; // whitespace.
    var path = match[2];
    var oper = match[3];
    if (path) {
      if (path === 'not') {
        const right = nud_expr(text, 'not');
        return new NotOp(right);
      } else {
        return new ScopeLookup(path.split('.'));
      }
    } else {
      log(`manglr: operator '${oper}' must follow an operand, in expression: '${text}' at position ${pos}`);
      return new ConstText("");
    }
  }
  log("manglr: expression cannot be empty");
  return new ConstText("");
}

function led_expr(text, aft_op) {
  for (;;) {
    var pos = expr_re.lastIndex;
    var match = expr_re.exec(text);
    log("led_expr:", JSON.stringify(match));
    if (!match) {
      log(`manglr: expecting an operand after operator '${aft_op}', but found nothing, in expression: '${text}' at position ${pos}`);
      return new ConstText("");
    }
    if (match[1]) continue; // whitespace.
    var dyadic = match[2] || match[3];
    const oper = dy_ops[dyadic];
    if (!oper) {
      log(`manglr: expecting an operator, but found '${dyadic}', in expression: '${text}' at position ${pos}`);
      return new ConstText("");
    }
    const right = led_expr(text, dyadic);
    return new oper(left, right);
  }
  log(`manglr: expecting an operand after operator '${aft_op}', but found '${dyadic}', in expression: '${text}' at position ${pos}`);
  return new ConstText("");
}

function parse_expr(text) {
  if (log_new) log("[ parse_expr:", text, "]");
  expr_re.lastIndex = 0;
  var res = nud_expr(text);
  for (;;) {
    var pos = expr_re.lastIndex;
    var match = expr_re.exec(text);
    if (!match) break; // end of input.
    if (match[1]) continue; // whitespace.
    const any = match[2] || match[3];
    log(`manglr: expected end of expression, but found '${any}', in expression: '${text}' at position ${pos}`);
    return new ConstText("");
  }
  return res;
}

function parse_text_tpl(text) {
  tpl_re.lastIndex = 0;
  var tpl = [];
  var i = 0;
  for (;;) {
    var match = tpl_re.exec(text);
    if (!match || !match[0]) break; // will match ["", "", ""] at the end!
    var literal = match[1];
    var expr = match[2];
    if (literal) tpl.push(new ConstText(literal));
    if (expr) {
      tpl.push(parse_expr(expr));
    }
    // tpl_re.lastIndex = match.index + match[0].length;
    if (i++ > 1000) throw "stop parse_text_tpl";
  }
  return tpl;
}

function parse_text_tpl_as_expr(text) {
  var tpl = parse_text_tpl(text);
  if (tpl.length === 1) return tpl[0];
  if (tpl.length === 0) return new ConstText("");
  return new ConcatText(tpl);
}

function parse_children(node, c_tags, comp_ctls) {
  // parse child nodes into their own tpl.
  var children = [];
  for (const child of node.childNodes) {
    parse_dom_node(child, c_tags, children, comp_ctls);
  }
  return children;
}

function parse_dom_node(node, c_tags, to_list, comp_ctls) {
  // parse a tpl out of the dom for spawning.
  // note: one DOM node can yield multiple AST nodes! (e.g. body text placeholders)
  var nodeType = node.nodeType;
  if (nodeType == 1) { // Element.
    var tag = node.tagName;
    if (tag === 'component' || tag === 'script') return; // elide from tpl.
    var tag_tpl = c_tags[tag];
    var proxy = new NodeProxy(node, tag_tpl);
    var attrs = node.attributes;
    for (const name of Object.keys(attrs)) {
      var value = attrs[name];
      if (value === '""') value = ''; // node-html-parser bug?
      var name_lc = name.toLowerCase();
      // check if the attribute name matches any registered directives.
      var handler = directives[name_lc];
      if (handler) {
          handler(proxy, value, "");
          continue; // next attribute.
      }
      // check if the attribute matches any registered prefix.
      if (~name_lc.indexOf('-')) {
        var m = name_lc.match(prefix_re);
        if (m) {
          var prefix = m[0];
          var suffix = name.substr(prefix.length);
          // custom binding handler.
          var handler = prefixes[prefix];
          handler(proxy, value, suffix);
          continue; // next attribute.
        } else {
          // warn if the attribute is not a standard HTML attribute.
          // TODO: use a database of standard HTML tags and their attributes.
          if (!tag_tpl && !std_attr.test(name_lc)) error(node, 1, name);
        }
      }
      // bind the attribute to the (text-template) expression.
      proxy.bind_attr(name, proxy.text_tpl(value));
    }
    var children = parse_children(node, c_tags, comp_ctls);
    proxy.add_children(children);
    // build the output DOM node.
    var out_node = null;
    var bi_comp = builtins[tag];
    if (bi_comp) {
      out_node = bi_comp(node, proxy, comp_ctls);
    } else if (tag_tpl) {
      out_node = new DomComponent(tag_tpl.tag, tag_tpl.id, proxy._binds, proxy._children);
    } else {
      // HTML element.
      if (~tag.indexOf('-')) error(node, 3, tag); // debugging: report custom tag names if not a component.
      out_node = new DomTag(tag, proxy._binds, proxy._children);
    }
    if (out_node) {
      // wrap the output node in repeats and conditions.
      // TODO: sort these using dep-sort, preferring conditions before repeats.
      for (var r=0, reps=proxy._repeats; r<reps.length/2; r+=2) {
        var r_expr = reps[r], r_name = reps[r+1];
        out_node = new RepeatNode(r_name, r_expr, [out_node]);
      }
      // emit all conditions with 1 child to follow
      for (var c=0, conds=proxy._conds; c<conds.length; c++) {
        out_node = new CondNode(conds[c], [out_node]);
      }
      // emit the DomComponent or DomTag
      to_list.push(out_node);
    }
  } else if (nodeType == 3) { // Text.
    // node.data: CharacterData, DOM level 1.
    var nodes = parse_text_tpl(node.text);
    for (var node of nodes) {
      if (node instanceof ConstText) {
        // re-wrap the text in a literal dom text node.
        to_list.push(new DomText(node.value));
      } else {
        // wrap the expr in a bound dom text node.
        to_list.push(new DomBoundText(node));
      }
    }
  }
}

function find_components(node, found, parent_comp) {
  // walk the dom tree to find all <component> tags.
  // must do this first because they can define custom tag names.
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      if (child.tagName === 'component') {
        // assign each component a unique id.
        const tpl_id = next_tpl_id++;
        const tag = child.attributes['tag'] || error(child, 8, ''); // missing attribute.
        const comp = { id:tpl_id, tpl:[], tags:{}, dom_node:child, tag:tag, parent:parent_comp };
        comp_list.push(comp);
        found.push(comp);
        if (tag) {
          // register the component in its parent by custom-tag name.
          const tag_set = parent_comp.tags;
          if (hasOwn.call(tag_set, tag)) error(node, 9, tag); // duplicate name.
          else tag_set[tag] = comp;
        }
        // find all components defined inside this component.
        find_components(child, found, comp);
      } else {
        find_components(child, found, parent_comp);
      }
    }
  }
}

function parse_components(found) {
  // in-order traversal: parents are processed before their children,
  // therefore c_tags will hoist all ancestor tags as well.
  for (const comp of found) {
    const node = comp.dom_node; comp.dom_node = null; // GC.
    // hoist `tags` from the parent (includes `tags` from all ancestors)
    const c_tags = comp.tags; // NB. mutated! (hoisted tags are added)
    const parent = comp.parent;
    if (parent) {
      const up_tags = parent.tags;
      for (const k of Object.keys(up_tags)) {
        if (c_tags[k]) error(node, 11, k); // component tag shadows another component.
        else c_tags[k] = up_tags[k];
      }
    }
    // parse dom nodes to create a template for spawning.
    const comp_ctls = []; // controller instances inside this component.
    const comp_els = parse_children(node, c_tags, comp_ctls);
    comp.tpl = comp_ctls.concat(comp_els);
    if (log_new) log("[ COMPONENT:", comp.tag, comp.tpl);
  }
}

function find_tag(tag, node) {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      if (child.tagName === tag) {
        return child;
      } else {
        const b = find_tag(tag, child);
        if (b) return b;
      }
    }
  }
}

function exists(filename) {
  try { fs.statSync(filename); return true; } catch (e) { return false; }
}

function find_inlines(in_node, src_dir) {
  for (const child of in_node.childNodes) {
    if (child.nodeType === 1) {
      var tag = child.tagName;
      if (tag === 'link') {
        var href, attrs = child.attributes;
        if (attrs['rel'] === 'stylesheet' && attrs['inline'] && (href=attrs['href'])) {
          if (/^file:\/\//.test(href)) href = href.substr(7); // remove "file://"
          if (!/^[a-zA-Z]*:?\/\//.test(href)) {
            // no protocol: must be a local file.
            var filename = path.resolve(src_dir, href);
            if (exists(filename)) {
              var content = fs.readFileSync(filename, 'utf8');
              child.tagName = 'style';
              child.rawAttrs = '';
              child.set_content([new html_parser.TextNode(content)]);
            } else {
              error(child, 19, filename);
            }
          }
        }
      }
      find_inlines(child, src_dir);
    }
  }
}

function b93_encode(nums) {
  // encode an array of small positive integers as ascii (single-byte) characters.
  // avoid for javascript: 34 " 92 \ 127 [delete]
  const res = [];
  for (const num of nums) {
    if (num < 0) throw "cannot b93_encode: "+num;
    // use ascii 32..94 (excluding 34, 92) to encode the least significant 61 values.
    var ch = 32 + (num % 61);
    if (ch >= 34) ++ch;
    if (ch >= 92) ++ch;
    var s = String.fromCharCode(ch);
    // var s = b93_set[num % 61];
    var acc = (num / 61) | 0;
    while (acc) {
      // encode 5 bits at a time, prepending higher bits to the result.
      // s = b93_set[61 + (acc & 31)] + s; // prepend 5-bit char (95..126)
      s = String.fromCharCode(95 + (acc & 31)) + s;
      acc = acc >> 5; // remaining high bits.
    }
    //console.log('\\'+s+'\\');
    res.push(s);
  }
  return res.join('');
}

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

function compile(source, src_dir, manglr_rtl) {
  const doc_el = parse_html(source);
  const html = find_tag('html', doc_el);
  if (!html) throw new Error(`missing <html> tag in ${doc_el}`);
  find_inlines(html, src_dir);
  // update the attribute prefix regex if register_prefix has been called.
  if (prefixes_dirty) rebuild_prefixes();
  // must find all component tags first, since they define custom tags.
  const body = find_tag('body', html);
  if (!body) throw new Error(`missing <body> tag in ${html}`);
  root_component.dom_node = body;
  var found = [root_component];
  find_components(body, found, root_component);
  // now parse the dom elements in each component.
  parse_components(found);
  // encode all templates for the runtime.
  var encoded = [comp_list.length]; // number of templates.
  for (var i=0; i<comp_list.length; i++) {
    encoded.push(0); // placeholder for template offset.
  }
  var prev_ofs = 0;
  for (var i=0; i<comp_list.length; i++) {
    encoded[1+i] = encoded.length - prev_ofs; // offset relative to previous template.
    prev_ofs = encoded.length; // save offset of previous template.
    var tpl = comp_list[i].tpl;
    encoded.push(tpl.length); // number of nodes.
    for (var n=0; n<tpl.length; n++) {
      tpl[n].encode(encoded);
    }
  }
  // encode the tpl data as text.
  const js_enc = JSON.stringify(encoded);
  if (log_out) console.log("=>", js_enc);
  const tpl_data = b93_encode(encoded);
  if (log_out) console.log("=>", JSON.stringify(tpl_data));
  if (log_out) console.log("=>", tpl_data.length, 'vs', js_enc.length, (tpl_data.length / js_enc.length * 100).toFixed(1)+'%');
  const enc_check = b93_decode(tpl_data);
  if (encoded.length !== enc_check.length) throw new Error("encoding error");
  for (let x=0; x<encoded.length; x++) if (encoded[x] !== enc_check[x]) throw new Error("encoding error")
  // remove all children from the body and add scripts.
  body.set_content([]);
  html.removeWhitespace();
  // inject the manglr runtime and encoded blob as scripts.
  const blob = `manglr("${tpl_data}",${JSON.stringify(sym_list)});`;
  const script_doc = parse_html(`<script>\n${manglr_rtl}/* Generated by Manglr compiler */\n${blob}\n</script>`);
  body.set_content(script_doc.childNodes);
  return '<!DOCTYPE html>\n' + html.outerHTML;
}

// ---- exports ----

module.exports = {
  compile: compile
};
