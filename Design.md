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


## Directives on components

Each component must be replaced by one native tag, otherwise directives on
component nodes won't have a real dom node to bind to.

But this severely restricts components: a component can be transparent to one
level (e.g. resolve to an <li>) but not at two levels (e.g. component contains
only another component that contains the <li>)

Perhaps directives and DOM attributes like 'class' and 'style' cannot be applied
to components; they serve a different purpose.

Optionally components can be defined as representing a standard HTML element,
and therefore directives can be applied.
