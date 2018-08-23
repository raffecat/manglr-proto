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
  var mod_conds = {};  // registry.
  var prefixes_dirty = true;
  var root_component = { id:'c0', cid:0, tags:{}, tpl:[], tag:'$' };
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
    'no handler registered for modular condition named "@"',                // 14
    'component requires an "@" attribute',                                  // 15
    'component "@" cannot be conditional or repeated',                      // 16
    'component "@" cannot have any child elements',                         // 17
  ];

  var log = console.log;

  function error(node, n, name, err) {
    console.log(manglr+': '+(error_msgs[n]||n).replace(/@/g,name), node, err);
  }


  // ---- Encoder Symbol Table ----

  var sym_list = [];
  var sym_map = new Map();

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

  function encode_inline(tpl, contents) {
    // encode an inline template with its size as prefix.
    var patch = tpl.length; tpl.push(0); // patch-pos for size of tpl.
    tpl.push(contents.length);
    contents.forEach(n => n.encode(tpl)); // apply encode(tpl) over contents.
    tpl[patch] = tpl.length - patch; // size of inline tpl.
  }

  function create_tpl(contents) {
    var cid = nextSid++;
    var sid = 't'+cid;
    // looks like a component, but only 'tpl' is used for encoding.
    var comp = { id:sid, cid:cid, tpl:contents };
    comp_list.push(comp);
    return cid;
  }

  function encode_named_nodes(tpl, binds) {
    // HACK : convert from attr_ops to expr_ops ...
    var pairs = [];
    for (var i=0; i<binds.length; i++) {
      var b = binds[i];
      if (b instanceof LiteralText) pairs.push(b.name, new ConstText(b.value));
      if (b instanceof BoundText) pairs.push(b.name, b.expr);
    }
    // encode the { name, expr } pairs.
    tpl.push(pairs.length/2);
    for (var i=0; i<pairs.length; i += 2) {
      tpl.push(sym(pairs[i])); // name of the node.
      pairs[i+1].encode(tpl);  // encode the node.
    }
  }

  var dom_ops = {
    text:            0,
    bound_text:      1,
    tag:             2,
    component:       3,
    condition:       4,
    repeat:          5,
    router:          6,
    authentication:  7,
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
    tpl.push(dom_ops.tag, sym(this.name), this.binds.length);
    this.binds.forEach(n => n.encode(tpl)); // reduce and encode each binding.
    tpl.push(this.contents.length);
    this.contents.forEach(n => n.encode(tpl)); // reduce and encode contents.
  };

  function DomComponent(name, cid, binds, contents) {
    this.name = name;
    this.cid = cid;
    this.binds = binds;
    this.contents = contents;
  }
  DomComponent.prototype.encode = function (tpl) {
    // need to resolve components before encode to determine which ones are used?
    // var comp = scope.c_tags[this.name];
    // if (!comp) error(this.node, 'no component found (in scope) for custom tag "'+this.name+'"');
    tpl.push(dom_ops.component, this.cid);
    encode_named_nodes(tpl, this.binds);
    encode_inline(tpl, this.contents);
  };

  function CondNode(expr, contents) {
    this.expr = expr;
    this.tpl_id = create_tpl(contents); // must reserve tpl slot before encoding begins.
  }
  CondNode.prototype.encode = function (tpl) {
    tpl.push(dom_ops.condition, this.tpl_id);
    this.expr.encode(tpl);
  };

  function RepeatNode(bind_as, expr, contents) {
    this.bind_as = bind_as;
    this.expr = expr;
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

  function AuthenticationNode(bind_as) {
    this.bind_as = bind_as;
  }
  AuthenticationNode.prototype.encode = function (tpl) {
    tpl.push(dom_ops.authentication, sym(this.bind_as));
  };


  // ---- Attribute AST Nodes ----

  var attr_ops = {
    literal_text:      0,
    literal_bool:      1,
    bound_text:        2,
    bound_bool:        3,
    literal_class:     4,
    bound_class:       5,
    cond_class:        6,
    bound_style:       7,
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
  }
  BoundText.prototype.encode = function (tpl) {
    tpl.push(attr_ops.bound_text, sym(this.name));
    this.expr.encode(tpl);
  };

  function BoundBool(name, expr) {
    this.name = name;
    this.expr = expr;
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
  }
  BoundClass.prototype.encode = function (tpl) {
    tpl.push(attr_ops.bound_class);
    this.expr.encode(tpl);
  };

  function CondClass(name, expr) {
    this.name = name;
    this.expr = expr;
  }
  CondClass.prototype.encode = function (tpl) {
    tpl.push(attr_ops.cond_class, sym(this.name));
    this.expr.encode(tpl);
  };

  function BoundStyle(name, expr) {
    this.name = name;
    this.expr = expr;
  }
  BoundStyle.prototype.encode = function (tpl) {
    tpl.push(attr_ops.bound_style, sym(this.name));
    this.expr.encode(tpl);
  };


  // ---- Expression AST Nodes ----

  var expr_ops = {
    const_text:     0,
    const_num:      1,
    scope_lookup:   2,
    concat_text:    3,
    equals:         4,
    add:            5,
    sub:            6,
    mul:            7,
    div:            8,
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


  // ---- modular conditions ----

  mod_conds['route'] = function (node, rest) {
    log("[ ROUTE COND:", rest, node);
    var route = node.implicit('@router', 'route');
    // TODO: need to trim `rest` before matching - text tpl can contain whitespace.
    return node.equals(route, node.text_tpl(rest));
  };


  // ---- directives ----

  directives['if'] = function (node, value) {
    log("[ IF:", value, node);
    // - compile the expression in the scope of `node`
    // - wrap the node in a condition node.
    node.cond(node.cond_expr(value));
  };

  directives['repeat'] = function (node, value) {
    log("[ REPEAT:", value, node);
    // - compile the expression in the scope of the inner nodes [repeat creates its own scopes]
    // - wrap the inner nodes in a condition node.
    var args = value.split(' from ');
    if (args.length !== 2) throw new Error('incorrect syntax - must be repeat="{expr} as name"');
    var name = args[0];
    var expr = args[1];
    node.repeat(node.expr(expr), name);
  };

  directives['if-route'] = function (node, value) {
    log("[ IF-ROUTE:", value, node);
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
    throw new Error("TODO: parse style attribute into bindings");
  };


  // ---- prefix handlers ----

  prefixes['class-'] = function(node, value, name) {
    log("[ CLASS:", name, value, node);
    node.cond_class(name, node.cond_expr(value));
  };

  prefixes['style-'] = function(node, value, name) {
    log("[ STYLE:", name, value, node);
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

  var tpl_re = new RegExp("([^{]*){?([^}]*)}?", "y");
  var mod_con_re = new RegExp("\\s*([A-Za-z][-A-Za-z0-9_]*):\\s*(.*)", "y"); // "cond-name: (expr)"
  var expr_re = new RegExp("\\s*(?:([@A-Za-z][A-Za-z0-9_.]*)|(\\+|\\-|\\*|\\/)|(.))", "y"); // (?:\\.\\w[\\w\\d_]*)*
  var norm_re = new RegExp("\\s+", "g")

  function norm_ws(text) {
    return text.replace(norm_re, " ");
  }

  var dy_ops = {
    '+': AddOp,
    '-': SubOp,
    '*': MulOp,
    '/': DivOp,
  };

  // some tentative parser stuff that needs to be re-written properly...

  function parse_expr(text) {
    log("[ parse_expr:", text, "]");
    expr_re.lastIndex = 0;
    var left = null;
    var i = 0;
    for (;;) {
      var match = expr_re.exec(text);
      // log("match:", match);
      if (!match) break; // end of input.
      var path = match[1];
      var dyadic = match[2];
      var any = match[3];
      if (path) {
        if (left) {
          // syntax error.
          log("manglr: expecting an operator, in expression:", text);
          return new ConstText("");
        }
        left = new ScopeLookup(path.split('.'));
      } else if (dyadic) {
        if (!left) {
          // syntax error.
          log("manglr: dyadic operator must follow an expression:", text);
          return new ConstText("");
        }
        right = parse_expr();
        left = new dy_ops[dyadic](left, right);
      } else if (any && !/^\s+$/.test(any)) {
        // FIXME: no, it backs up one char so it can match a space against the '.' x_x
        log("manglr: syntax error in expression:", text, expr_re.lastIndex);
        return new ConstText("");
      } else {
        // skipped whitespace and reached end of input.
        break;
      }
      if (i++ > 1000) throw "stop parse_expr";
    }
    // end of input.
    if (!left) {
      log("manglr: expression cannot be empty:", text);
      return new ConstText("");
    }
    return left;
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
    var child = node.firstChild;
    while (child != null) {
      parse_dom_node(child, c_tags, children, comp_ctls);
      child = child.nextSibling;
    }
    return children;
  }

  function parse_dom_node(node, c_tags, to_list, comp_ctls) {
    // parse a tpl out of the dom for spawning.
    // note: one DOM node can yield multiple AST nodes! (e.g. body text placeholders)
    var nodeType = node.nodeType;
    if (nodeType == 1) { // Element.
      var tag = node.nodeName.toLowerCase();
      if (tag === 'component' || tag === 'script') return; // elide from tpl.
      var tag_tpl = c_tags[tag];
      var proxy = new NodeProxy(node, tag_tpl);
      var attrs = node.attributes;
      for (var i=0,n=attrs&&attrs.length; i<n; i++) {
        var attr = attrs[i];
        if (attr.specified) {
          var name = attr.name;
          var name_lc = name.toLowerCase();
          var value = attr.value;
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
      }
      var children = parse_children(node, c_tags, comp_ctls);
      proxy.add_children(children);
      // build the output DOM node.
      var out_node = null;
      if (tag === 'router') {
        // TODO: move this to a tag registry.
        if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, tag); return; }
        if (proxy._children['length']) { error(node, 17, tag); return; } // TODO: ignore DomText whitespace.
        log("[ ROUTER:", proxy);
        var id = find_literal_text(proxy, 'id');
        if (!id) { error(node, 15, 'id'); return; }
        comp_ctls.push(new RouterNode(id));
      } else if (tag === 'authentication') {
        // TODO: move this to a tag registry.
        if (proxy._repeats['length'] || proxy._conds['length']) { error(node, 16, tag); return; }
        log("[ AUTHENTICATION:", proxy);
        var id = find_literal_text(proxy, 'id');
        if (!id) { error(node, 15, 'id'); return; }
        comp_ctls.push(new AuthenticationNode(id));
        // leave the authentication contents in-place, but wrap in a condition node.
        if (proxy._children.length) {
          var auth_expr = proxy.implicit(id, 'auth_required');
          out_node = new CondNode(auth_expr, proxy._children);
        }
      } else if (tag_tpl) {
        out_node = new DomComponent(tag_tpl.tag, tag_tpl.cid, proxy._binds, proxy._children);
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
      var nodes = parse_text_tpl(node.data);
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

  function find_literal_text(proxy, name) {
    var binds = proxy._binds;
    for (var bind of binds) {
      if (bind instanceof LiteralText && bind.name === name) {
        return bind.value;
      }
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
      var tag = node.getAttribute('tag') || error(node, 8, ''); // missing attribute.
      var comp = { id:sid, cid:cid, tpl:[], tags:{}, node:node, tag:tag };
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
      var comp_ctls = []; // controller instances inside this component.
      var comp_els = parse_children(node, c_tags, comp_ctls);
      comp.tpl = comp_ctls.concat(comp_els);
      log("[ COMPONENT:", comp.tag, comp.tpl);
    }
  }

  function clear_doc_body() {
    // remove the children of body.
    var body = document.body;
    var child = body.firstChild;
    while (child != null) {
      var next = child.nextSibling;
      body.removeChild(child);
      child = next;
    }
  }

  function parse_document(doc) {
    // update the attribute prefix regex if register_prefix has been called.
    if (prefixes_dirty) rebuild_prefixes();
    // must find all component tags first, since they affect walk_dom.
    find_components(doc);
    // parse the remaining document body into the root component.
    var root_ctls = []; // controller instances inside this component.
    var root_els = parse_children(document.body, root_component.tags, root_ctls);
    root_component.tpl = root_ctls.concat(root_els);
    // empty the document body for the runtime to re-populate.
    clear_doc_body();
    // encode all templates for the runtime.
    var encoded = [];
    for (var i=0; i<comp_list.length; i++) {
      encoded.push(0); // placeholder for tpl offset.
    }
    for (var i=0; i<comp_list.length; i++) {
      encoded[i] = encoded.length;
      var tpl = comp_list[i].tpl;
      encoded.push(tpl.length); // number of nodes.
      for (var n=0; n<tpl.length; n++) {
        tpl[n].encode(encoded);
      }
    }
    var payload = [encoded, sym_list];
    log("payload:", payload);
    log(JSON.stringify(payload));
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
