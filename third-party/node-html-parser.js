"use strict";

/* 
 *  https://github.com/taoqf/node-fast-html-parser
 *  License MIT
 *  Version 1.1.9a - MODIFIED
 *  - kMarkupPattern to allow multiple dashes.
 *  - toString to use HTML5 rules (no solidus on void elements)
 */

Object.defineProperty(exports, "__esModule", { value: true });
const he_1 = require("he");
var NodeType;
(function (NodeType) {
    NodeType[NodeType["ELEMENT_NODE"] = 1] = "ELEMENT_NODE";
    NodeType[NodeType["TEXT_NODE"] = 3] = "TEXT_NODE";
})(NodeType = exports.NodeType || (exports.NodeType = {}));
/**
 * Node Class as base class for TextNode and HTMLElement.
 */
class Node {
    constructor() {
        this.childNodes = [];
    }
}
exports.Node = Node;
/**
 * TextNode to contain a text element in DOM tree.
 * @param {string} value [description]
 */
class TextNode extends Node {
    constructor(value) {
        super();
        /**
         * Node Type declaration.
         * @type {Number}
         */
        this.nodeType = NodeType.TEXT_NODE;
        this.rawText = value;
    }
    /**
     * Get unescaped text value of current node and its children.
     * @return {string} text content
     */
    get text() {
        return he_1.decode(this.rawText);
    }
    /**
     * Detect if the node contains only white space.
     * @return {bool}
     */
    get isWhitespace() {
        return /^(\s|&nbsp;)*$/.test(this.rawText);
    }
    toString() {
        return this.text;
    }
}
exports.TextNode = TextNode;
const kBlockElements = {
    div: true,
    p: true,
    // ul: true,
    // ol: true,
    li: true,
    // table: true,
    // tr: true,
    td: true,
    section: true,
    br: true
};
function arr_back(arr) {
    return arr[arr.length - 1];
}
/**
 * HTMLElement, which contains a set of children.
 *
 * Note: this is a minimalist implementation, no complete tree
 *   structure provided (no parentNode, nextSibling,
 *   previousSibling etc).
 * @class HTMLElement
 * @extends {Node}
 */
class HTMLElement extends Node {
    /**
     * Creates an instance of HTMLElement.
     * @param {string} name       tagName
     * @param {KeyAttributes} keyAttrs  id and class attribute
     * @param {string} [rawAttrs] attributes in string
     *
     * @memberof HTMLElement
     */
    constructor(name, keyAttrs, rawAttrs) {
        super();
        this.classNames = [];
        /**
         * Node Type declaration.
         * @type {Number}
         */
        this.nodeType = NodeType.ELEMENT_NODE;
        this.tagName = name;
        this.rawAttrs = rawAttrs || '';
        // this.parentNode = null;
        this.childNodes = [];
        if (keyAttrs.id) {
            this.id = keyAttrs.id;
        }
        if (keyAttrs.class) {
            this.classNames = keyAttrs.class.split(/\s+/);
        }
    }
    /**
     * Get escpaed (as-it) text value of current node and its children.
     * @return {string} text content
     */
    get rawText() {
        let res = '';
        for (let i = 0; i < this.childNodes.length; i++)
            res += this.childNodes[i].rawText;
        return res;
    }
    /**
     * Get unescaped text value of current node and its children.
     * @return {string} text content
     */
    get text() {
        return he_1.decode(this.rawText);
    }
    /**
     * Get structured Text (with '\n' etc.)
     * @return {string} structured text
     */
    get structuredText() {
        let currentBlock = [];
        const blocks = [currentBlock];
        function dfs(node) {
            if (node.nodeType === NodeType.ELEMENT_NODE) {
                if (kBlockElements[node.tagName]) {
                    if (currentBlock.length > 0) {
                        blocks.push(currentBlock = []);
                    }
                    node.childNodes.forEach(dfs);
                    if (currentBlock.length > 0) {
                        blocks.push(currentBlock = []);
                    }
                }
                else {
                    node.childNodes.forEach(dfs);
                }
            }
            else if (node.nodeType === NodeType.TEXT_NODE) {
                if (node.isWhitespace) {
                    // Whitespace node, postponed output
                    currentBlock.prependWhitespace = true;
                }
                else {
                    let text = node.text;
                    if (currentBlock.prependWhitespace) {
                        text = ' ' + text;
                        currentBlock.prependWhitespace = false;
                    }
                    currentBlock.push(text);
                }
            }
        }
        dfs(this);
        return blocks
            .map(function (block) {
            // Normalize each line's whitespace
            return block.join('').trim().replace(/\s{2,}/g, ' ');
        })
            .join('\n').replace(/\s+$/, ''); // trimRight;
    }
    toString() {
        const tag = this.tagName;
        if (tag) {
            // Modified to use HTML5 rules (no solidus on void elements)
            // https://www.w3.org/TR/html5/syntax.html#start-tags
            const is_void_el = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag);
            const attrs = this.rawAttrs ? ' ' + this.rawAttrs : '';
            if (is_void_el) {
                return `<${tag}${attrs}>`;
            }
            else {
                return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
            }
        }
        else {
            return this.innerHTML;
        }
    }
    get innerHTML() {
        return this.childNodes.map((child) => {
            return child.toString();
        }).join('');
    }
    set_content(content) {
        if (content instanceof Node) {
            content = [content];
        }
        else if (typeof content == 'string') {
            const r = parse(content);
            content = r.childNodes.length ? r.childNodes : [new TextNode(content)];
        }
        this.childNodes = content;
    }
    get outerHTML() {
        return this.toString();
    }
    /**
     * Trim element from right (in block) after seeing pattern in a TextNode.
     * @param  {RegExp} pattern pattern to find
     * @return {HTMLElement}    reference to current node
     */
    trimRight(pattern) {
        function dfs(node) {
            for (let i = 0; i < node.childNodes.length; i++) {
                const childNode = node.childNodes[i];
                if (childNode.nodeType === NodeType.ELEMENT_NODE) {
                    dfs(childNode);
                }
                else {
                    const index = childNode.rawText.search(pattern);
                    if (index > -1) {
                        childNode.rawText = childNode.rawText.substr(0, index);
                        // trim all following nodes.
                        node.childNodes.length = i + 1;
                    }
                }
            }
        }
        dfs(this);
        return this;
    }
    /**
     * Get DOM structure
     * @return {string} strucutre
     */
    get structure() {
        const res = [];
        let indention = 0;
        function write(str) {
            res.push('  '.repeat(indention) + str);
        }
        function dfs(node) {
            const idStr = node.id ? ('#' + node.id) : '';
            const classStr = node.classNames.length ? ('.' + node.classNames.join('.')) : '';
            write(node.tagName + idStr + classStr);
            indention++;
            for (let i = 0; i < node.childNodes.length; i++) {
                const childNode = node.childNodes[i];
                if (childNode.nodeType === NodeType.ELEMENT_NODE) {
                    dfs(childNode);
                }
                else if (childNode.nodeType === NodeType.TEXT_NODE) {
                    if (!childNode.isWhitespace)
                        write('#text');
                }
            }
            indention--;
        }
        dfs(this);
        return res.join('\n');
    }
    /**
     * Remove whitespaces in this sub tree.
     * @return {HTMLElement} pointer to this
     */
    removeWhitespace() {
        let o = 0;
        for (let i = 0; i < this.childNodes.length; i++) {
            const node = this.childNodes[i];
            if (node.nodeType === NodeType.TEXT_NODE) {
                if (node.isWhitespace)
                    continue;
                node.rawText = node.rawText.trim();
            }
            else if (node.nodeType === NodeType.ELEMENT_NODE) {
                node.removeWhitespace();
            }
            this.childNodes[o++] = node;
        }
        this.childNodes.length = o;
        return this;
    }
    /**
     * Query CSS selector to find matching nodes.
     * @param  {string}         selector Simplified CSS selector
     * @param  {Matcher}        selector A Matcher instance
     * @return {HTMLElement[]}  matching elements
     */
    querySelectorAll(selector) {
        let matcher;
        if (selector instanceof Matcher) {
            matcher = selector;
            matcher.reset();
        }
        else {
            matcher = new Matcher(selector);
        }
        const res = [];
        const stack = [];
        for (let i = 0; i < this.childNodes.length; i++) {
            stack.push([this.childNodes[i], 0, false]);
            while (stack.length) {
                const state = arr_back(stack);
                const el = state[0];
                if (state[1] === 0) {
                    // Seen for first time.
                    if (el.nodeType !== NodeType.ELEMENT_NODE) {
                        stack.pop();
                        continue;
                    }
                    if (state[2] = matcher.advance(el)) {
                        if (matcher.matched) {
                            res.push(el);
                            // no need to go further.
                            matcher.rewind();
                            stack.pop();
                            continue;
                        }
                    }
                }
                if (state[1] < el.childNodes.length) {
                    stack.push([el.childNodes[state[1]++], 0, false]);
                }
                else {
                    if (state[2])
                        matcher.rewind();
                    stack.pop();
                }
            }
        }
        return res;
    }
    /**
     * Query CSS Selector to find matching node.
     * @param  {string}         selector Simplified CSS selector
     * @param  {Matcher}        selector A Matcher instance
     * @return {HTMLElement}    matching node
     */
    querySelector(selector) {
        let matcher;
        if (selector instanceof Matcher) {
            matcher = selector;
            matcher.reset();
        }
        else {
            matcher = new Matcher(selector);
        }
        const stack = [];
        for (let i = 0; i < this.childNodes.length; i++) {
            stack.push([this.childNodes[i], 0, false]);
            while (stack.length) {
                const state = arr_back(stack);
                const el = state[0];
                if (state[1] === 0) {
                    // Seen for first time.
                    if (el.nodeType !== NodeType.ELEMENT_NODE) {
                        stack.pop();
                        continue;
                    }
                    if (state[2] = matcher.advance(el)) {
                        if (matcher.matched) {
                            return el;
                        }
                    }
                }
                if (state[1] < el.childNodes.length) {
                    stack.push([el.childNodes[state[1]++], 0, false]);
                }
                else {
                    if (state[2])
                        matcher.rewind();
                    stack.pop();
                }
            }
        }
        return null;
    }
    /**
     * Append a child node to childNodes
     * @param  {Node} node node to append
     * @return {Node}      node appended
     */
    appendChild(node) {
        // node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }
    /**
     * Get first child node
     * @return {Node} first child node
     */
    get firstChild() {
        return this.childNodes[0];
    }
    /**
     * Get last child node
     * @return {Node} last child node
     */
    get lastChild() {
        return arr_back(this.childNodes);
    }
    /**
     * Get attributes
     * @return {Object} parsed and unescaped attributes
     */
    get attributes() {
        if (this._attrs)
            return this._attrs;
        this._attrs = {};
        const attrs = this.rawAttributes;
        for (const key in attrs) {
            this._attrs[key] = he_1.decode(attrs[key]);
        }
        return this._attrs;
    }
    /**
     * Get escaped (as-it) attributes
     * @return {Object} parsed attributes
     */
    get rawAttributes() {
        if (this._rawAttrs)
            return this._rawAttrs;
        const attrs = {};
        if (this.rawAttrs) {
            // modified: parse attributes without a value as name="name" per HTML5
            const re = /\b([a-z][a-z0-9\-]*)\s*(?:=\s*("([^"]+)"|'([^']+)'|(\S+)))?/ig;
            let match;
            while (match = re.exec(this.rawAttrs)) {
                attrs[match[1]] = match[3] || match[4] || match[5] || match[1];
            }
        }
        this._rawAttrs = attrs;
        return attrs;
    }
}
exports.HTMLElement = HTMLElement;
/**
 * Cache to store generated match functions
 * @type {Object}
 */
let pMatchFunctionCache = {};
/**
 * Matcher class to make CSS match
 *
 * @class Matcher
 */
class Matcher {
    /**
     * Creates an instance of Matcher.
     * @param {string} selector
     *
     * @memberof Matcher
     */
    constructor(selector) {
        this.nextMatch = 0;
        this.matchers = selector.split(' ').map((matcher) => {
            if (pMatchFunctionCache[matcher])
                return pMatchFunctionCache[matcher];
            const parts = matcher.split('.');
            const tagName = parts[0];
            const classes = parts.slice(1).sort();
            let source = '"use strict";';
            if (tagName && tagName != '*') {
                let matcher;
                if (tagName[0] == '#') {
                    source += 'if (el.id != ' + JSON.stringify(tagName.substr(1)) + ') return false;';
                }
                else if (matcher = tagName.match(/^\[\s*(\S+)\s*(=|!=)\s*((((["'])([^\6]*)\6))|(\S*?))\]\s*/)) {
                    const attr_key = matcher[1];
                    let method = matcher[2];
                    if (method !== '=' && method !== '!=') {
                        throw new Error('Selector not supported, Expect [key${op}value].op must be =,!=');
                    }
                    if (method === '=') {
                        method = '==';
                    }
                    const value = matcher[7] || matcher[8];
                    source += `var attrs = el.attributes;for (var key in attrs){const val = attrs[key]; if (key == "${attr_key}" && val ${method} "${value}"){return true;}} return false;`;
                }
                else {
                    source += 'if (el.tagName != ' + JSON.stringify(tagName) + ') return false;';
                }
            }
            if (classes.length > 0) {
                source += 'for (var cls = ' + JSON.stringify(classes) + ', i = 0; i < cls.length; i++) if (el.classNames.indexOf(cls[i]) === -1) return false;';
            }
            source += 'return true;';
            return pMatchFunctionCache[matcher] = new Function('el', source);
        });
    }
    /**
     * Trying to advance match pointer
     * @param  {HTMLElement} el element to make the match
     * @return {bool}           true when pointer advanced.
     */
    advance(el) {
        if (this.nextMatch < this.matchers.length &&
            this.matchers[this.nextMatch](el)) {
            this.nextMatch++;
            return true;
        }
        return false;
    }
    /**
     * Rewind the match pointer
     */
    rewind() {
        this.nextMatch--;
    }
    /**
     * Trying to determine if match made.
     * @return {bool} true when the match is made
     */
    get matched() {
        return this.nextMatch == this.matchers.length;
    }
    /**
     * Rest match pointer.
     * @return {[type]} [description]
     */
    reset() {
        this.nextMatch = 0;
    }
    /**
     * flush cache to free memory
     */
    flushCache() {
        pMatchFunctionCache = {};
    }
}
exports.Matcher = Matcher;
// https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name
const kMarkupPattern = /<!--[^]*?(?=-->)-->|<(\/?)([a-z][-.0-9_a-z]*)\s*([^>]*?)(\/?)>/ig;
const kAttributePattern = /(^|\s)(id|class)\s*=\s*("([^"]+)"|'([^']+)'|(\S+))/ig;
const kSelfClosingElements = {
    meta: true,
    img: true,
    link: true,
    input: true,
    area: true,
    br: true,
    hr: true
};
const kElementsClosedByOpening = {
    li: { li: true },
    p: { p: true, div: true },
    td: { td: true, th: true },
    th: { td: true, th: true }
};
const kElementsClosedByClosing = {
    li: { ul: true, ol: true },
    a: { div: true },
    b: { div: true },
    i: { div: true },
    p: { div: true },
    td: { tr: true, table: true },
    th: { tr: true, table: true }
};
const kBlockTextElements = {
    script: true,
    noscript: true,
    style: true,
    pre: true
};
/**
 * Parses HTML and returns a root element
 * Parse a chuck of HTML source.
 * @param  {string} data      html
 * @return {HTMLElement}      root element
 */
function parse(data, options) {
    const root = new HTMLElement(null, {});
    let currentParent = root;
    const stack = [root];
    let lastTextPos = -1;
    options = options || {};
    let match;
    while (match = kMarkupPattern.exec(data)) {
        if (lastTextPos > -1) {
            if (lastTextPos + match[0].length < kMarkupPattern.lastIndex) {
                // if has content
                const text = data.substring(lastTextPos, kMarkupPattern.lastIndex - match[0].length);
                currentParent.appendChild(new TextNode(text));
            }
        }
        lastTextPos = kMarkupPattern.lastIndex;
        if (match[0][1] == '!') {
            // this is a comment
            continue;
        }
        if (options.lowerCaseTagName)
            match[2] = match[2].toLowerCase();
        if (!match[1]) {
            // not </ tags
            var attrs = {};
            for (var attMatch; attMatch = kAttributePattern.exec(match[3]);)
                attrs[attMatch[2]] = attMatch[4] || attMatch[5] || attMatch[6];
            // console.log(attrs);
            if (!match[4] && kElementsClosedByOpening[currentParent.tagName]) {
                if (kElementsClosedByOpening[currentParent.tagName][match[2]]) {
                    stack.pop();
                    currentParent = arr_back(stack);
                }
            }
            currentParent = currentParent.appendChild(new HTMLElement(match[2], attrs, match[3]));
            stack.push(currentParent);
            if (kBlockTextElements[match[2]]) {
                // a little test to find next </script> or </style> ...
                var closeMarkup = '</' + match[2] + '>';
                var index = data.indexOf(closeMarkup, kMarkupPattern.lastIndex);
                if (options[match[2]]) {
                    let text;
                    if (index == -1) {
                        // there is no matching ending for the text element.
                        text = data.substr(kMarkupPattern.lastIndex);
                    }
                    else {
                        text = data.substring(kMarkupPattern.lastIndex, index);
                    }
                    if (text.length > 0)
                        currentParent.appendChild(new TextNode(text));
                }
                if (index == -1) {
                    lastTextPos = kMarkupPattern.lastIndex = data.length + 1;
                }
                else {
                    lastTextPos = kMarkupPattern.lastIndex = index + closeMarkup.length;
                    match[1] = 'true';
                }
            }
        }
        if (match[1] || match[4] ||
            kSelfClosingElements[match[2]]) {
            // </ or /> or <br> etc.
            while (true) {
                if (currentParent.tagName == match[2]) {
                    stack.pop();
                    currentParent = arr_back(stack);
                    break;
                }
                else {
                    // Trying to close current tag, and move on
                    if (kElementsClosedByClosing[currentParent.tagName]) {
                        if (kElementsClosedByClosing[currentParent.tagName][match[2]]) {
                            stack.pop();
                            currentParent = arr_back(stack);
                            continue;
                        }
                    }
                    // Use aggressive strategy to handle unmatching markups.
                    break;
                }
            }
        }
    }
    return root;
}
exports.parse = parse;
