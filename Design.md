# Design Decisions

Components can be defined inside other components.
Components can replace any tag name in their scope, so they must be found first.

getElementsByTagName [depth first]
- tag with an id
- find nearest parent component and grab its id
- not scopes, because those are per instance!

Components work on an opt-in system: if there is a component defined in scope
with the same name as any tag, that tag will be replaced with the component.

Directives work the same way: if a directive is registered with the same name
as any attribute on any tag, that directive will be applied to that tag.

Real-time registration:
- assume all directives are registered before DOMContentLoaded [error if late]
- apply directives to the page as they are registered [complexity!]


## Component nesting

The simple choice here is to consider every component an isolated scope, and
therefore ignore nesting entirely. Names must be unique within one file.

Lexical components: a component can directly refer to any name in the scope
where it is defined, and any component available in that scope.

Specifically, this means a component can use another component defined at a
higher nesting level, and that must bring its closed-over bindings with it.

When a scope is created for a component instance, we must (on demand) create
a closure for each component defined inside that component. We also need to
know the tag-names of all components in scope: those are used to parse the
component nodes.

1. build the component tree
2. breadth first: build a map of tag-names in scope for each component
3. parse each component using the map of tag-names


## Resolving names

Each name used within a component must be either an 'in' argument to that
component, defined locally, or must be part of its lexical closure.

Consider: even if we don't know whether a tag is a component or not, all of
its input arguments are known [unless their interpretation depends on type]

Bindings into scope: 'in' arguments create bindings. Repeat directives create
a sub-scope with its own binding. Store and Model tags create bindings.

When a component is used with an 'if' directive, its bindings are known even
if they are not always active. Can components bind new names?


## Indirect bindings

When we iterate over a collection of models, each template instance is bound
to names of fields on that model. If the model is swapped (i.e. not keyed)
for an instance, all of those bindings need to be re-bound to a new model.

What if models are always keyed? Give each model a unique id, and create a
new template instance for a new model (re-parent and re-order nodes for
existing models) Thus bindings to models cannot change.

Now introduce a slot in a model that holds another model, and change the
value in that slot [mutable refs to models]

Either we subscribe to mutable slots like this, or we use a sync pass to
update all the bindings [a global pass scales poorly]


## Spawning

- Repeat, if, route: create and destroy scoped instances.
- Contents [transclude]: should move or templateize the contents?

traverse body with scope:
- component -> [attrs and contents are bindings] -> new scope -> traverse body
- text -> [one binding to data] -> createTextNode -> bind evaluator
- element -> [attrs and bindings] -> createElement -> setAttribute -> bind attributes

bind attribute:
- resolve names -> deps in scope (once)
- fields: subscribe to dep -> update: [if model] resolve name to dep in model -> subscribe to dep
- text or text attr: subscribe to dep -> update: [if string or number] toString [else] ''

Boolean attributes:
- contenteditable, spellcheck -> only "true" and "" and no-value mean true
- https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes
- https://github.com/kangax/html-minifier/issues/63
- https://stackoverflow.com/questions/706384/boolean-html-attributes?utm_medium=organic&utm_source=google_rich_qa&utm_campaign=google_rich_qa


## IE 7

- https://msdn.microsoft.com/en-us/ie/ms536389(v=vs.94)
- http://kangax.github.io/nfe/

In Internet Explorer, you can specify all the attributes inside the createElement
method by using an HTML string for the method argument.

You must perform a second step when you use createElement to create the input element.
The createElement method generates an input text box, because that is the default input
type property. To insert any other kind of input element, first invoke createElement for
input, and then set the type property to the appropriate value in the next line of code.
Attributes can be included with the eTag as long as the entire string is valid HTML.
To include the NAME attribute at run time on objects created with the createElement method,
use the eTag. Use the eTag to include attributes when form elements are created that will
be reset using the reset method or a BUTTON with a TYPE attribute value of reset.

```
// Create radio button object with value="First Choice" and then insert this element into the document hierarchy.
var newRadioButton = document.createElement('input');
newRadioButton.setAttribute('type', 'radio');
newRadioButton.setAttribute('name', 'radio1');
newRadioButton.setAttribute('value', 'First Choice');
document.body.insertBefore(newRadioButton); // Since the second argument is implicity null, this inserts the radio button at the end of this node's list of children ("this" node refers to the body element).
```


## Directives on components

Each component must be replaced by one native tag, otherwise directives on
component nodes won't have a real dom node to bind to.

But this severely restricts components: a component can be transparent to one
level (e.g. resolve to an `<li>`) but not at two levels (e.g. component contains
only another component that contains the `<li>`)

Perhaps directives and DOM attributes like 'class' and 'style' cannot be applied
to components; they serve a different purpose.

Optionally components can be defined as representing a standard HTML element,
and therefore directives can be applied.


## Creating Templates

When an `if` becomes true -> walk template and create dom nodes, traversing any
component instances [making scopes for them that persist as long as the instance]

When a `repeat` node is updated -> iterate over the collection of models,

TODO: rather inefficient in some cases where searching is required.
Spawning can always be reduced to two steps:
- find the insertion point (next sibling after previous Node/Scope)
- create the tpl using that insertion point.


## Repeat Nodes

Repeat nodes must be able to move their contents. When the collection of models
is re-ordered [or even moved from collection to collection] the runtime must be
able to move the contents of each repeat node into the new document order.

Need some virtual dom here: repeat nodes, if nodes and component nodes are all
virtual, in that they don't necessarily have a single top-level node, but rather
a list of top-level nodes. Even text with placeholders could be implemented as
a virtual node, creating a dom Text node for each placeholder and text span.

By using globally unique keys and deferring deletion (transactionally), we could
actually re-parent dom nodes anywhere in the tree.


## Tear-down

When a subtree is removed - e.g. due to repeat/if/route change, traverse the subtree
under that node, remove dom nodes and scopes.

All deps are bound to a scope, and all scopes [except the root] are bound to a parent
scope, so destroying a scope is enough to unbind all subscribed deps.

Cannot destroy dom nodes, so must remove them [the top-level ones] from the dom and
drop all refs to them [particularly in closures attached to deps in scopes].


## MVP

The simplest implementation is to pull templates out of the dom for components
and `repeat` nodes, use cloneNode to duplicate them, and then walk the copies
without any pre-processing. Every component MUST have a top-level dom node.
Insert placeholder nodes for `if` and `repeat` and add/remove dom nodes after
the placeholder. For `if` nodes, unbind and drop the dom on remove, and
therefore also use cloneNode and walk the copy in insert. If initially true,
can cloneNode a copy of the `if` and walk the exising nodes.

An `if` [false] followed by a `repeat`: the `if` inserts a placeholder node,
so the `repeat` placeholder can be inserted after that. An `if` [true] that
becomes [false] does not affect the following `repeat`.

A `repeat` that contains an `if` [false] that later becomes [true]: how does
the repeat keep track of the current node in the `if`? By id: cannot put an
id on a text node or comment node, so no go. By ref: need to update that ref
when swapping the `if` in and out. Repeat should hold a vnode that holds the
dom node (i.e. `if` always generates a vnode.)

A `repeat` that contains a `repeat` where the outer repeat needs to re-order
its views: so a repeat must be a real dom node - or a vnode that has a list
of vnodes for the contents [if,repeat,dom] - also wrap dom nodes in vnodes
to keep it regular.


## Crisis

Q: Build it for AoT or build it for in-browser use? Or both?!

In browser: should modify and bind to nodes in-place when the script loads,
to avoid scroll reset, clearing input fields, restarting video, and so on.
-> only take control of if/repeat/component nodes.

Pre-render: same rules as in-browser: pre-rendered nodes should not be removed
or replaced when the script loads, but directives should enhance those nodes.
-> have the spawn process take ownership of existing nodes by id or position.

I think the in-browser compiler is just a prototype: due to old browser
limitations and new browser features, custom tags like <component> and bound
attributes like <img src="{url}"> will always cause problems in production.

Could work around these: use a prefix 'v-' for bindings; <component> seems
to be ok in modern browsers.
