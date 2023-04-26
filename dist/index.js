import { showPanel, EditorView, getPanel, Decoration, ViewPlugin, runScopeHandlers } from '@codemirror/view';
import { codePointAt, fromCodePoint, codePointSize, StateEffect, StateField, EditorSelection, Facet, combineConfig, CharCategory, RangeSetBuilder, Prec, EditorState, findClusterBreak } from '@codemirror/state';
import elt from 'crelt';

const basicNormalize = typeof String.prototype.normalize == "function"
    ? x => x.normalize("NFKD") : x => x;
/// A search cursor provides an iterator over text matches in a
/// document.
class SearchCursor {
    /// Create a text cursor. The query is the search string, `from` to
    /// `to` provides the region to search.
    ///
    /// When `normalize` is given, it will be called, on both the query
    /// string and the content it is matched against, before comparing.
    /// You can, for example, create a case-insensitive search by
    /// passing `s => s.toLowerCase()`.
    ///
    /// Text is always normalized with
    /// [`.normalize("NFKD")`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize)
    /// (when supported).
    constructor(text, query, from = 0, to = text.length, normalize, test) {
        this.test = test;
        /// The current match (only holds a meaningful value after
        /// [`next`](#search.SearchCursor.next) has been called and when
        /// `done` is false).
        this.value = { from: 0, to: 0 };
        /// Whether the end of the iterated region has been reached.
        this.done = false;
        this.matches = [];
        this.buffer = "";
        this.bufferPos = 0;
        this.iter = text.iterRange(from, to);
        this.bufferStart = from;
        this.normalize = normalize ? x => normalize(basicNormalize(x)) : basicNormalize;
        this.query = this.normalize(query);
    }
    peek() {
        if (this.bufferPos == this.buffer.length) {
            this.bufferStart += this.buffer.length;
            this.iter.next();
            if (this.iter.done)
                return -1;
            this.bufferPos = 0;
            this.buffer = this.iter.value;
        }
        return codePointAt(this.buffer, this.bufferPos);
    }
    /// Look for the next match. Updates the iterator's
    /// [`value`](#search.SearchCursor.value) and
    /// [`done`](#search.SearchCursor.done) properties. Should be called
    /// at least once before using the cursor.
    next() {
        while (this.matches.length)
            this.matches.pop();
        return this.nextOverlapping();
    }
    /// The `next` method will ignore matches that partially overlap a
    /// previous match. This method behaves like `next`, but includes
    /// such matches.
    nextOverlapping() {
        for (;;) {
            let next = this.peek();
            if (next < 0) {
                this.done = true;
                return this;
            }
            let str = fromCodePoint(next), start = this.bufferStart + this.bufferPos;
            this.bufferPos += codePointSize(next);
            let norm = this.normalize(str);
            for (let i = 0, pos = start;; i++) {
                let code = norm.charCodeAt(i);
                let match = this.match(code, pos);
                if (match) {
                    this.value = match;
                    return this;
                }
                if (i == norm.length - 1)
                    break;
                if (pos == start && i < str.length && str.charCodeAt(i) == code)
                    pos++;
            }
        }
    }
    match(code, pos) {
        let match = null;
        for (let i = 0; i < this.matches.length; i += 2) {
            let index = this.matches[i], keep = false;
            if (this.query.charCodeAt(index) == code) {
                if (index == this.query.length - 1) {
                    match = { from: this.matches[i + 1], to: pos + 1 };
                }
                else {
                    this.matches[i]++;
                    keep = true;
                }
            }
            if (!keep) {
                this.matches.splice(i, 2);
                i -= 2;
            }
        }
        if (this.query.charCodeAt(0) == code) {
            if (this.query.length == 1)
                match = { from: pos, to: pos + 1 };
            else
                this.matches.push(1, pos);
        }
        if (match && this.test && !this.test(match.from, match.to, this.buffer, this.bufferPos))
            match = null;
        return match;
    }
}
if (typeof Symbol != "undefined")
    SearchCursor.prototype[Symbol.iterator] = function () { return this; };

const empty = { from: -1, to: -1, match: /*@__PURE__*//.*/.exec("") };
const baseFlags = "gm" + (/x/.unicode == null ? "" : "u");
/// This class is similar to [`SearchCursor`](#search.SearchCursor)
/// but searches for a regular expression pattern instead of a plain
/// string.
class RegExpCursor {
    /// Create a cursor that will search the given range in the given
    /// document. `query` should be the raw pattern (as you'd pass it to
    /// `new RegExp`).
    constructor(text, query, options, from = 0, to = text.length) {
        this.text = text;
        this.to = to;
        this.curLine = "";
        /// Set to `true` when the cursor has reached the end of the search
        /// range.
        this.done = false;
        /// Will contain an object with the extent of the match and the
        /// match object when [`next`](#search.RegExpCursor.next)
        /// sucessfully finds a match.
        this.value = empty;
        if (/\\[sWDnr]|\n|\r|\[\^/.test(query))
            return new MultilineRegExpCursor(text, query, options, from, to);
        this.re = new RegExp(query, baseFlags + ((options === null || options === void 0 ? void 0 : options.ignoreCase) ? "i" : ""));
        this.test = options === null || options === void 0 ? void 0 : options.test;
        this.iter = text.iter();
        let startLine = text.lineAt(from);
        this.curLineStart = startLine.from;
        this.matchPos = toCharEnd(text, from);
        this.getLine(this.curLineStart);
    }
    getLine(skip) {
        this.iter.next(skip);
        if (this.iter.lineBreak) {
            this.curLine = "";
        }
        else {
            this.curLine = this.iter.value;
            if (this.curLineStart + this.curLine.length > this.to)
                this.curLine = this.curLine.slice(0, this.to - this.curLineStart);
            this.iter.next();
        }
    }
    nextLine() {
        this.curLineStart = this.curLineStart + this.curLine.length + 1;
        if (this.curLineStart > this.to)
            this.curLine = "";
        else
            this.getLine(0);
    }
    /// Move to the next match, if there is one.
    next() {
        for (let off = this.matchPos - this.curLineStart;;) {
            this.re.lastIndex = off;
            let match = this.matchPos <= this.to && this.re.exec(this.curLine);
            if (match) {
                let from = this.curLineStart + match.index, to = from + match[0].length;
                this.matchPos = toCharEnd(this.text, to + (from == to ? 1 : 0));
                if (from == this.curLineStart + this.curLine.length)
                    this.nextLine();
                if ((from < to || from > this.value.to) && (!this.test || this.test(from, to, match))) {
                    this.value = { from, to, match };
                    return this;
                }
                off = this.matchPos - this.curLineStart;
            }
            else if (this.curLineStart + this.curLine.length < this.to) {
                this.nextLine();
                off = 0;
            }
            else {
                this.done = true;
                return this;
            }
        }
    }
}
const flattened = /*@__PURE__*/new WeakMap();
// Reusable (partially) flattened document strings
class FlattenedDoc {
    constructor(from, text) {
        this.from = from;
        this.text = text;
    }
    get to() { return this.from + this.text.length; }
    static get(doc, from, to) {
        let cached = flattened.get(doc);
        if (!cached || cached.from >= to || cached.to <= from) {
            let flat = new FlattenedDoc(from, doc.sliceString(from, to));
            flattened.set(doc, flat);
            return flat;
        }
        if (cached.from == from && cached.to == to)
            return cached;
        let { text, from: cachedFrom } = cached;
        if (cachedFrom > from) {
            text = doc.sliceString(from, cachedFrom) + text;
            cachedFrom = from;
        }
        if (cached.to < to)
            text += doc.sliceString(cached.to, to);
        flattened.set(doc, new FlattenedDoc(cachedFrom, text));
        return new FlattenedDoc(from, text.slice(from - cachedFrom, to - cachedFrom));
    }
}
class MultilineRegExpCursor {
    constructor(text, query, options, from, to) {
        this.text = text;
        this.to = to;
        this.done = false;
        this.value = empty;
        this.matchPos = toCharEnd(text, from);
        this.re = new RegExp(query, baseFlags + ((options === null || options === void 0 ? void 0 : options.ignoreCase) ? "i" : ""));
        this.test = options === null || options === void 0 ? void 0 : options.test;
        this.flat = FlattenedDoc.get(text, from, this.chunkEnd(from + 5000 /* Chunk.Base */));
    }
    chunkEnd(pos) {
        return pos >= this.to ? this.to : this.text.lineAt(pos).to;
    }
    next() {
        for (;;) {
            let off = this.re.lastIndex = this.matchPos - this.flat.from;
            let match = this.re.exec(this.flat.text);
            // Skip empty matches directly after the last match
            if (match && !match[0] && match.index == off) {
                this.re.lastIndex = off + 1;
                match = this.re.exec(this.flat.text);
            }
            if (match) {
                let from = this.flat.from + match.index, to = from + match[0].length;
                // If a match goes almost to the end of a noncomplete chunk, try
                // again, since it'll likely be able to match more
                if ((this.flat.to >= this.to || match.index + match[0].length <= this.flat.text.length - 10) &&
                    (!this.test || this.test(from, to, match))) {
                    this.value = { from, to, match };
                    this.matchPos = toCharEnd(this.text, to + (from == to ? 1 : 0));
                    return this;
                }
            }
            if (this.flat.to == this.to) {
                this.done = true;
                return this;
            }
            // Grow the flattened doc
            this.flat = FlattenedDoc.get(this.text, this.flat.from, this.chunkEnd(this.flat.from + this.flat.text.length * 2));
        }
    }
}
if (typeof Symbol != "undefined") {
    RegExpCursor.prototype[Symbol.iterator] = MultilineRegExpCursor.prototype[Symbol.iterator] =
        function () { return this; };
}
function validRegExp(source) {
    try {
        new RegExp(source, baseFlags);
        return true;
    }
    catch (_a) {
        return false;
    }
}
function toCharEnd(text, pos) {
    if (pos >= text.length)
        return pos;
    let line = text.lineAt(pos), next;
    while (pos < line.to && (next = line.text.charCodeAt(pos - line.from)) >= 0xDC00 && next < 0xE000)
        pos++;
    return pos;
}

function createLineDialog(view) {
    let input = elt("input", { class: "cm-textfield", name: "line" });
    let dom = elt("form", {
        class: "cm-gotoLine",
        onkeydown: (event) => {
            if (event.keyCode == 27) { // Escape
                event.preventDefault();
                view.dispatch({ effects: dialogEffect.of(false) });
                view.focus();
            }
            else if (event.keyCode == 13) { // Enter
                event.preventDefault();
                go();
            }
        },
        onsubmit: (event) => {
            event.preventDefault();
            go();
        }
    }, elt("label", view.state.phrase("Go to line"), ": ", input), " ", elt("button", { class: "cm-button", type: "submit" }, view.state.phrase("go")));
    function go() {
        let match = /^([+-])?(\d+)?(:\d+)?(%)?$/.exec(input.value);
        if (!match)
            return;
        let { state } = view, startLine = state.doc.lineAt(state.selection.main.head);
        let [, sign, ln, cl, percent] = match;
        let col = cl ? +cl.slice(1) : 0;
        let line = ln ? +ln : startLine.number;
        if (ln && percent) {
            let pc = line / 100;
            if (sign)
                pc = pc * (sign == "-" ? -1 : 1) + (startLine.number / state.doc.lines);
            line = Math.round(state.doc.lines * pc);
        }
        else if (ln && sign) {
            line = line * (sign == "-" ? -1 : 1) + startLine.number;
        }
        let docLine = state.doc.line(Math.max(1, Math.min(state.doc.lines, line)));
        view.dispatch({
            effects: dialogEffect.of(false),
            selection: EditorSelection.cursor(docLine.from + Math.max(0, Math.min(col, docLine.length))),
            scrollIntoView: true
        });
        view.focus();
    }
    return { dom };
}
const dialogEffect = /*@__PURE__*/StateEffect.define();
const dialogField = /*@__PURE__*/StateField.define({
    create() { return true; },
    update(value, tr) {
        for (let e of tr.effects)
            if (e.is(dialogEffect))
                value = e.value;
        return value;
    },
    provide: f => showPanel.from(f, val => val ? createLineDialog : null)
});
/// Command that shows a dialog asking the user for a line number, and
/// when a valid position is provided, moves the cursor to that line.
///
/// Supports line numbers, relative line offsets prefixed with `+` or
/// `-`, document percentages suffixed with `%`, and an optional
/// column position by adding `:` and a second number after the line
/// number.
const gotoLine = view => {
    let panel = getPanel(view, createLineDialog);
    if (!panel) {
        let effects = [dialogEffect.of(true)];
        if (view.state.field(dialogField, false) == null)
            effects.push(StateEffect.appendConfig.of([dialogField, baseTheme$1]));
        view.dispatch({ effects });
        panel = getPanel(view, createLineDialog);
    }
    if (panel)
        panel.dom.querySelector("input").focus();
    return true;
};
const baseTheme$1 = /*@__PURE__*/EditorView.baseTheme({
    ".cm-panel.cm-gotoLine": {
        padding: "2px 6px 4px",
        "& label": { fontSize: "80%" }
    }
});

const defaultHighlightOptions = {
    highlightWordAroundCursor: false,
    minSelectionLength: 1,
    maxMatches: 100,
    wholeWords: false
};
const highlightConfig = /*@__PURE__*/Facet.define({
    combine(options) {
        return combineConfig(options, defaultHighlightOptions, {
            highlightWordAroundCursor: (a, b) => a || b,
            minSelectionLength: Math.min,
            maxMatches: Math.min
        });
    }
});
/// This extension highlights text that matches the selection. It uses
/// the `"cm-selectionMatch"` class for the highlighting. When
/// `highlightWordAroundCursor` is enabled, the word at the cursor
/// itself will be highlighted with `"cm-selectionMatch-main"`.
function highlightSelectionMatches(options) {
    let ext = [defaultTheme, matchHighlighter];
    if (options)
        ext.push(highlightConfig.of(options));
    return ext;
}
const matchDeco = /*@__PURE__*/Decoration.mark({ class: "cm-selectionMatch" });
const mainMatchDeco = /*@__PURE__*/Decoration.mark({ class: "cm-selectionMatch cm-selectionMatch-main" });
// Whether the characters directly outside the given positions are non-word characters
function insideWordBoundaries(check, state, from, to) {
    return (from == 0 || check(state.sliceDoc(from - 1, from)) != CharCategory.Word) &&
        (to == state.doc.length || check(state.sliceDoc(to, to + 1)) != CharCategory.Word);
}
// Whether the characters directly at the given positions are word characters
function insideWord(check, state, from, to) {
    return check(state.sliceDoc(from, from + 1)) == CharCategory.Word
        && check(state.sliceDoc(to - 1, to)) == CharCategory.Word;
}
const matchHighlighter = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.getDeco(view);
    }
    update(update) {
        if (update.selectionSet || update.docChanged || update.viewportChanged)
            this.decorations = this.getDeco(update.view);
    }
    getDeco(view) {
        let conf = view.state.facet(highlightConfig);
        let { state } = view, sel = state.selection;
        if (sel.ranges.length > 1)
            return Decoration.none;
        let range = sel.main, query, check = null;
        if (range.empty) {
            if (!conf.highlightWordAroundCursor)
                return Decoration.none;
            let word = state.wordAt(range.head);
            if (!word)
                return Decoration.none;
            check = state.charCategorizer(range.head);
            query = state.sliceDoc(word.from, word.to);
        }
        else {
            let len = range.to - range.from;
            if (len < conf.minSelectionLength || len > 200)
                return Decoration.none;
            if (conf.wholeWords) {
                query = state.sliceDoc(range.from, range.to); // TODO: allow and include leading/trailing space?
                check = state.charCategorizer(range.head);
                if (!(insideWordBoundaries(check, state, range.from, range.to)
                    && insideWord(check, state, range.from, range.to)))
                    return Decoration.none;
            }
            else {
                query = state.sliceDoc(range.from, range.to).trim();
                if (!query)
                    return Decoration.none;
            }
        }
        let deco = [];
        for (let part of view.visibleRanges) {
            let cursor = new SearchCursor(state.doc, query, part.from, part.to);
            while (!cursor.next().done) {
                let { from, to } = cursor.value;
                if (!check || insideWordBoundaries(check, state, from, to)) {
                    if (range.empty && from <= range.from && to >= range.to)
                        deco.push(mainMatchDeco.range(from, to));
                    else if (from >= range.to || to <= range.from)
                        deco.push(matchDeco.range(from, to));
                    if (deco.length > conf.maxMatches)
                        return Decoration.none;
                }
            }
        }
        return Decoration.set(deco);
    }
}, {
    decorations: v => v.decorations
});
const defaultTheme = /*@__PURE__*/EditorView.baseTheme({
    ".cm-selectionMatch": { backgroundColor: "#99ff7780" },
    ".cm-searchMatch .cm-selectionMatch": { backgroundColor: "transparent" }
});
// Select the words around the cursors.
const selectWord = ({ state, dispatch }) => {
    let { selection } = state;
    let newSel = EditorSelection.create(selection.ranges.map(range => state.wordAt(range.head) || EditorSelection.cursor(range.head)), selection.mainIndex);
    if (newSel.eq(selection))
        return false;
    dispatch(state.update({ selection: newSel }));
    return true;
};
// Find next occurrence of query relative to last cursor. Wrap around
// the document if there are no more matches.
function findNextOccurrence(state, query) {
    let { main, ranges } = state.selection;
    let word = state.wordAt(main.head), fullWord = word && word.from == main.from && word.to == main.to;
    for (let cycled = false, cursor = new SearchCursor(state.doc, query, ranges[ranges.length - 1].to);;) {
        cursor.next();
        if (cursor.done) {
            if (cycled)
                return null;
            cursor = new SearchCursor(state.doc, query, 0, Math.max(0, ranges[ranges.length - 1].from - 1));
            cycled = true;
        }
        else {
            if (cycled && ranges.some(r => r.from == cursor.value.from))
                continue;
            if (fullWord) {
                let word = state.wordAt(cursor.value.from);
                if (!word || word.from != cursor.value.from || word.to != cursor.value.to)
                    continue;
            }
            return cursor.value;
        }
    }
}
/// Select next occurrence of the current selection. Expand selection
/// to the surrounding word when the selection is empty.
const selectNextOccurrence = ({ state, dispatch }) => {
    let { ranges } = state.selection;
    if (ranges.some(sel => sel.from === sel.to))
        return selectWord({ state, dispatch });
    let searchedText = state.sliceDoc(ranges[0].from, ranges[0].to);
    if (state.selection.ranges.some(r => state.sliceDoc(r.from, r.to) != searchedText))
        return false;
    let range = findNextOccurrence(state, searchedText);
    if (!range)
        return false;
    dispatch(state.update({
        selection: state.selection.addRange(EditorSelection.range(range.from, range.to), false),
        effects: EditorView.scrollIntoView(range.to)
    }));
    return true;
};

const searchConfigFacet = /*@__PURE__*/Facet.define({
    combine(configs) {
        return combineConfig(configs, {
            top: true,
            caseSensitive: false,
            literal: false,
            wholeWord: false,
            createPanel: view => new SearchPanel(view),
            scrollToMatch: range => EditorView.scrollIntoView(range)
        });
    }
});
/// Add search state to the editor configuration, and optionally
/// configure the search extension.
/// ([`openSearchPanel`](#search.openSearchPanel) will automatically
/// enable this if it isn't already on).
function search(config) {
    return config ? [searchConfigFacet.of(config), searchExtensions] : searchExtensions;
}
/// A search query. Part of the editor's search state.
class SearchQuery {
    /// Create a query object.
    constructor(config) {
        this.search = config.search;
        this.caseSensitive = !!config.caseSensitive;
        this.literal = !!config.literal;
        this.regexp = !!config.regexp;
        this.replace = config.replace || "";
        this.valid = !!this.search && (!this.regexp || validRegExp(this.search));
        this.unquoted = this.unquote(this.search);
        this.wholeWord = !!config.wholeWord;
    }
    /// @internal
    unquote(text) {
        return this.literal ? text :
            text.replace(/\\([nrt\\])/g, (_, ch) => ch == "n" ? "\n" : ch == "r" ? "\r" : ch == "t" ? "\t" : "\\");
    }
    /// Compare this query to another query.
    eq(other) {
        return this.search == other.search && this.replace == other.replace &&
            this.caseSensitive == other.caseSensitive && this.regexp == other.regexp &&
            this.wholeWord == other.wholeWord;
    }
    /// @internal
    create() {
        return this.regexp ? new RegExpQuery(this) : new StringQuery(this);
    }
    /// Get a search cursor for this query, searching through the given
    /// range in the given state.
    getCursor(state, from = 0, to) {
        let st = state.doc ? state : EditorState.create({ doc: state });
        if (to == null)
            to = st.doc.length;
        return this.regexp ? regexpCursor(this, st, from, to) : stringCursor(this, st, from, to);
    }
}
class QueryType {
    constructor(spec) {
        this.spec = spec;
    }
}
function stringCursor(spec, state, from, to) {
    return new SearchCursor(state.doc, spec.unquoted, from, to, spec.caseSensitive ? undefined : x => x.toLowerCase(), spec.wholeWord ? stringWordTest(state.doc, state.charCategorizer(state.selection.main.head)) : undefined);
}
function stringWordTest(doc, categorizer) {
    return (from, to, buf, bufPos) => {
        if (bufPos > from || bufPos + buf.length < to) {
            bufPos = Math.max(0, from - 2);
            buf = doc.sliceString(bufPos, Math.min(doc.length, to + 2));
        }
        return (categorizer(charBefore(buf, from - bufPos)) != CharCategory.Word ||
            categorizer(charAfter(buf, from - bufPos)) != CharCategory.Word) &&
            (categorizer(charAfter(buf, to - bufPos)) != CharCategory.Word ||
                categorizer(charBefore(buf, to - bufPos)) != CharCategory.Word);
    };
}
class StringQuery extends QueryType {
    constructor(spec) {
        super(spec);
    }
    nextMatch(state, curFrom, curTo) {
        let cursor = stringCursor(this.spec, state, curTo, state.doc.length).nextOverlapping();
        if (cursor.done)
            cursor = stringCursor(this.spec, state, 0, curFrom).nextOverlapping();
        return cursor.done ? null : cursor.value;
    }
    // Searching in reverse is, rather than implementing inverted search
    // cursor, done by scanning chunk after chunk forward.
    prevMatchInRange(state, from, to) {
        for (let pos = to;;) {
            let start = Math.max(from, pos - 10000 /* FindPrev.ChunkSize */ - this.spec.unquoted.length);
            let cursor = stringCursor(this.spec, state, start, pos), range = null;
            while (!cursor.nextOverlapping().done)
                range = cursor.value;
            if (range)
                return range;
            if (start == from)
                return null;
            pos -= 10000 /* FindPrev.ChunkSize */;
        }
    }
    prevMatch(state, curFrom, curTo) {
        return this.prevMatchInRange(state, 0, curFrom) ||
            this.prevMatchInRange(state, curTo, state.doc.length);
    }
    getReplacement(_result) { return this.spec.unquote(this.spec.replace); }
    matchAll(state, limit) {
        let cursor = stringCursor(this.spec, state, 0, state.doc.length), ranges = [];
        while (!cursor.next().done) {
            if (ranges.length >= limit)
                return null;
            ranges.push(cursor.value);
        }
        return ranges;
    }
    highlight(state, from, to, add) {
        let cursor = stringCursor(this.spec, state, Math.max(0, from - this.spec.unquoted.length), Math.min(to + this.spec.unquoted.length, state.doc.length));
        while (!cursor.next().done)
            add(cursor.value.from, cursor.value.to);
    }
}
function regexpCursor(spec, state, from, to) {
    return new RegExpCursor(state.doc, spec.search, {
        ignoreCase: !spec.caseSensitive,
        test: spec.wholeWord ? regexpWordTest(state.charCategorizer(state.selection.main.head)) : undefined
    }, from, to);
}
function charBefore(str, index) {
    return str.slice(findClusterBreak(str, index, false), index);
}
function charAfter(str, index) {
    return str.slice(index, findClusterBreak(str, index));
}
function regexpWordTest(categorizer) {
    return (_from, _to, match) => !match[0].length ||
        (categorizer(charBefore(match.input, match.index)) != CharCategory.Word ||
            categorizer(charAfter(match.input, match.index)) != CharCategory.Word) &&
            (categorizer(charAfter(match.input, match.index + match[0].length)) != CharCategory.Word ||
                categorizer(charBefore(match.input, match.index + match[0].length)) != CharCategory.Word);
}
class RegExpQuery extends QueryType {
    nextMatch(state, curFrom, curTo) {
        let cursor = regexpCursor(this.spec, state, curTo, state.doc.length).next();
        if (cursor.done)
            cursor = regexpCursor(this.spec, state, 0, curFrom).next();
        return cursor.done ? null : cursor.value;
    }
    prevMatchInRange(state, from, to) {
        for (let size = 1;; size++) {
            let start = Math.max(from, to - size * 10000 /* FindPrev.ChunkSize */);
            let cursor = regexpCursor(this.spec, state, start, to), range = null;
            while (!cursor.next().done)
                range = cursor.value;
            if (range && (start == from || range.from > start + 10))
                return range;
            if (start == from)
                return null;
        }
    }
    prevMatch(state, curFrom, curTo) {
        return this.prevMatchInRange(state, 0, curFrom) ||
            this.prevMatchInRange(state, curTo, state.doc.length);
    }
    getReplacement(result) {
        return this.spec.unquote(this.spec.replace.replace(/\$([$&\d+])/g, (m, i) => i == "$" ? "$"
            : i == "&" ? result.match[0]
                : i != "0" && +i < result.match.length ? result.match[i]
                    : m));
    }
    matchAll(state, limit) {
        let cursor = regexpCursor(this.spec, state, 0, state.doc.length), ranges = [];
        while (!cursor.next().done) {
            if (ranges.length >= limit)
                return null;
            ranges.push(cursor.value);
        }
        return ranges;
    }
    highlight(state, from, to, add) {
        let cursor = regexpCursor(this.spec, state, Math.max(0, from - 250 /* RegExp.HighlightMargin */), Math.min(to + 250 /* RegExp.HighlightMargin */, state.doc.length));
        while (!cursor.next().done)
            add(cursor.value.from, cursor.value.to);
    }
}
/// A state effect that updates the current search query. Note that
/// this only has an effect if the search state has been initialized
/// (by including [`search`](#search.search) in your configuration or
/// by running [`openSearchPanel`](#search.openSearchPanel) at least
/// once).
const setSearchQuery = /*@__PURE__*/StateEffect.define();
const togglePanel = /*@__PURE__*/StateEffect.define();
const searchState = /*@__PURE__*/StateField.define({
    create(state) {
        return new SearchState(defaultQuery(state).create(), null);
    },
    update(value, tr) {
        for (let effect of tr.effects) {
            if (effect.is(setSearchQuery))
                value = new SearchState(effect.value.create(), value.panel);
            else if (effect.is(togglePanel))
                value = new SearchState(value.query, effect.value ? createSearchPanel : null);
        }
        return value;
    },
    provide: f => showPanel.from(f, val => val.panel)
});
/// Get the current search query from an editor state.
function getSearchQuery(state) {
    let curState = state.field(searchState, false);
    return curState ? curState.query.spec : defaultQuery(state);
}
/// Query whether the search panel is open in the given editor state.
function searchPanelOpen(state) {
    var _a;
    return ((_a = state.field(searchState, false)) === null || _a === void 0 ? void 0 : _a.panel) != null;
}
class SearchState {
    constructor(query, panel) {
        this.query = query;
        this.panel = panel;
    }
}
const matchMark = /*@__PURE__*/Decoration.mark({ class: "cm-searchMatch" }), selectedMatchMark = /*@__PURE__*/Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });
const searchHighlighter = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor(view) {
        this.view = view;
        this.decorations = this.highlight(view.state.field(searchState));
    }
    update(update) {
        let state = update.state.field(searchState);
        if (state != update.startState.field(searchState) || update.docChanged || update.selectionSet || update.viewportChanged)
            this.decorations = this.highlight(state);
    }
    highlight({ query, panel }) {
        if (!panel || !query.spec.valid)
            return Decoration.none;
        let { view } = this;
        let builder = new RangeSetBuilder();
        for (let i = 0, ranges = view.visibleRanges, l = ranges.length; i < l; i++) {
            let { from, to } = ranges[i];
            while (i < l - 1 && to > ranges[i + 1].from - 2 * 250 /* RegExp.HighlightMargin */)
                to = ranges[++i].to;
            query.highlight(view.state, from, to, (from, to) => {
                let selected = view.state.selection.ranges.some(r => r.from == from && r.to == to);
                builder.add(from, to, selected ? selectedMatchMark : matchMark);
            });
        }
        return builder.finish();
    }
}, {
    decorations: v => v.decorations
});
function searchCommand(f) {
    return view => {
        let state = view.state.field(searchState, false);
        return state && state.query.spec.valid ? f(view, state) : openSearchPanel(view);
    };
}
/// Open the search panel if it isn't already open, and move the
/// selection to the first match after the current main selection.
/// Will wrap around to the start of the document when it reaches the
/// end.
const findNext = /*@__PURE__*/searchCommand((view, { query }) => {
    let { to } = view.state.selection.main;
    let next = query.nextMatch(view.state, to, to);
    if (!next)
        return false;
    let selection = EditorSelection.single(next.from, next.to);
    let config = view.state.facet(searchConfigFacet);
    view.dispatch({
        selection,
        effects: [announceMatch(view, next), config.scrollToMatch(selection.main, view)],
        userEvent: "select.search"
    });
    selectSearchInput(view);
    return true;
});
/// Move the selection to the previous instance of the search query,
/// before the current main selection. Will wrap past the start
/// of the document to start searching at the end again.
const findPrevious = /*@__PURE__*/searchCommand((view, { query }) => {
    let { state } = view, { from } = state.selection.main;
    let prev = query.prevMatch(state, from, from);
    if (!prev)
        return false;
    let selection = EditorSelection.single(prev.from, prev.to);
    let config = view.state.facet(searchConfigFacet);
    view.dispatch({
        selection,
        effects: [announceMatch(view, prev), config.scrollToMatch(selection.main, view)],
        userEvent: "select.search"
    });
    selectSearchInput(view);
    return true;
});
/// Select all instances of the search query.
const selectMatches = /*@__PURE__*/searchCommand((view, { query }) => {
    let ranges = query.matchAll(view.state, 1000);
    if (!ranges || !ranges.length)
        return false;
    view.dispatch({
        selection: EditorSelection.create(ranges.map(r => EditorSelection.range(r.from, r.to))),
        userEvent: "select.search.matches"
    });
    return true;
});
/// Select all instances of the currently selected text.
const selectSelectionMatches = ({ state, dispatch }) => {
    let sel = state.selection;
    if (sel.ranges.length > 1 || sel.main.empty)
        return false;
    let { from, to } = sel.main;
    let ranges = [], main = 0;
    for (let cur = new SearchCursor(state.doc, state.sliceDoc(from, to)); !cur.next().done;) {
        if (ranges.length > 1000)
            return false;
        if (cur.value.from == from)
            main = ranges.length;
        ranges.push(EditorSelection.range(cur.value.from, cur.value.to));
    }
    dispatch(state.update({
        selection: EditorSelection.create(ranges, main),
        userEvent: "select.search.matches"
    }));
    return true;
};
/// Replace the current match of the search query.
const replaceNext = /*@__PURE__*/searchCommand((view, { query }) => {
    let { state } = view, { from, to } = state.selection.main;
    if (state.readOnly)
        return false;
    let next = query.nextMatch(state, from, from);
    if (!next)
        return false;
    let changes = [], selection, replacement;
    let effects = [];
    if (next.from == from && next.to == to) {
        replacement = state.toText(query.getReplacement(next));
        changes.push({ from: next.from, to: next.to, insert: replacement });
        next = query.nextMatch(state, next.from, next.to);
        effects.push(EditorView.announce.of(state.phrase("replaced match on line $", state.doc.lineAt(from).number) + "."));
    }
    if (next) {
        let off = changes.length == 0 || changes[0].from >= next.to ? 0 : next.to - next.from - replacement.length;
        selection = EditorSelection.single(next.from - off, next.to - off);
        effects.push(announceMatch(view, next));
        effects.push(state.facet(searchConfigFacet).scrollToMatch(selection.main, view));
    }
    view.dispatch({
        changes, selection, effects,
        userEvent: "input.replace"
    });
    return true;
});
/// Replace all instances of the search query with the given
/// replacement.
const replaceAll = /*@__PURE__*/searchCommand((view, { query }) => {
    if (view.state.readOnly)
        return false;
    let changes = query.matchAll(view.state, 1e9).map(match => {
        let { from, to } = match;
        return { from, to, insert: query.getReplacement(match) };
    });
    if (!changes.length)
        return false;
    let announceText = view.state.phrase("replaced $ matches", changes.length) + ".";
    view.dispatch({
        changes,
        effects: EditorView.announce.of(announceText),
        userEvent: "input.replace.all"
    });
    return true;
});
function createSearchPanel(view) {
    return view.state.facet(searchConfigFacet).createPanel(view);
}
function defaultQuery(state, fallback) {
    var _a, _b, _c, _d;
    let sel = state.selection.main;
    let selText = sel.empty || sel.to > sel.from + 100 ? "" : state.sliceDoc(sel.from, sel.to);
    if (fallback && !selText)
        return fallback;
    let config = state.facet(searchConfigFacet);
    return new SearchQuery({
        search: ((_a = fallback === null || fallback === void 0 ? void 0 : fallback.literal) !== null && _a !== void 0 ? _a : config.literal) ? selText : selText.replace(/\n/g, "\\n"),
        caseSensitive: (_b = fallback === null || fallback === void 0 ? void 0 : fallback.caseSensitive) !== null && _b !== void 0 ? _b : config.caseSensitive,
        literal: (_c = fallback === null || fallback === void 0 ? void 0 : fallback.literal) !== null && _c !== void 0 ? _c : config.literal,
        wholeWord: (_d = fallback === null || fallback === void 0 ? void 0 : fallback.wholeWord) !== null && _d !== void 0 ? _d : config.wholeWord
    });
}
function getSearchInput(view) {
    let panel = getPanel(view, createSearchPanel);
    return panel && panel.dom.querySelector("[main-field]");
}
function selectSearchInput(view) {
    let input = getSearchInput(view);
    if (input && input == view.root.activeElement)
        input.select();
}
/// Make sure the search panel is open and focused.
const openSearchPanel = view => {
    let state = view.state.field(searchState, false);
    if (state && state.panel) {
        let searchInput = getSearchInput(view);
        if (searchInput && searchInput != view.root.activeElement) {
            let query = defaultQuery(view.state, state.query.spec);
            if (query.valid)
                view.dispatch({ effects: setSearchQuery.of(query) });
            searchInput.focus();
            searchInput.select();
        }
    }
    else {
        view.dispatch({ effects: [
                togglePanel.of(true),
                state ? setSearchQuery.of(defaultQuery(view.state, state.query.spec)) : StateEffect.appendConfig.of(searchExtensions)
            ] });
    }
    return true;
};
/// Close the search panel.
const closeSearchPanel = view => {
    let state = view.state.field(searchState, false);
    if (!state || !state.panel)
        return false;
    let panel = getPanel(view, createSearchPanel);
    if (panel && panel.dom.contains(view.root.activeElement))
        view.focus();
    view.dispatch({ effects: togglePanel.of(false) });
    return true;
};
/// Default search-related key bindings.
///
///  - Mod-f: [`openSearchPanel`](#search.openSearchPanel)
///  - F3, Mod-g: [`findNext`](#search.findNext)
///  - Shift-F3, Shift-Mod-g: [`findPrevious`](#search.findPrevious)
///  - Alt-g: [`gotoLine`](#search.gotoLine)
///  - Mod-d: [`selectNextOccurrence`](#search.selectNextOccurrence)
const searchKeymap = [
    { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel" },
    { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
    { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
    { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
    { key: "Mod-Shift-l", run: selectSelectionMatches },
    { key: "Alt-g", run: gotoLine },
    { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
];
class SearchPanel {
    constructor(view) {
        this.view = view;
        let query = this.query = view.state.field(searchState).query.spec;
        this.commit = this.commit.bind(this);
        this.searchField = elt("input", {
            value: query.search,
            placeholder: phrase(view, "Find"),
            "aria-label": phrase(view, "Find"),
            class: "cm-textfield",
            name: "search",
            form: "",
            "main-field": "true",
            onchange: this.commit,
            onkeyup: this.commit
        });
        this.replaceField = elt("input", {
            value: query.replace,
            placeholder: phrase(view, "Replace"),
            "aria-label": phrase(view, "Replace"),
            class: "cm-textfield",
            name: "replace",
            form: "",
            onchange: this.commit,
            onkeyup: this.commit
        });
        this.caseField = elt("input", {
            type: "checkbox",
            name: "case",
            form: "",
            checked: query.caseSensitive,
            onchange: this.commit
        });
        this.reField = elt("input", {
            type: "checkbox",
            name: "re",
            form: "",
            checked: query.regexp,
            onchange: this.commit
        });
        this.wordField = elt("input", {
            type: "checkbox",
            name: "word",
            form: "",
            checked: query.wholeWord,
            onchange: this.commit
        });
        function button(name, onclick, content) {
            return elt("button", { class: "cm-button", name, onclick, type: "button", "aria-label": phrase(view, name) }, content);
        }
        this.dom = elt("div", { onkeydown: (e) => this.keydown(e), class: "cm-search" }, [
            this.searchField,
            button("next", () => findNext(view), ['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="m3.147 9l5 5h.707l5-5l-.707-.707L9 12.439V2H8v10.44L3.854 8.292L3.147 9z" clip-rule="evenodd"/></svg>']),
            button("prev", () => findPrevious(view), ['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="m13.854 7l-5-5h-.707l-5 5l.707.707L8 3.561V14h1V3.56l4.146 4.147l.708-.707z" clip-rule="evenodd"/></svg>']),
            button("select", () => selectMatches(view), [phrase(view, "all")]),
            elt("label", null, [this.caseField, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8.854 11.702h-1l-.816-2.159H3.772l-.768 2.16H2L4.954 4h.935l2.965 7.702Zm-2.111-2.97L5.534 5.45a3.142 3.142 0 0 1-.118-.515h-.021c-.036.218-.077.39-.124.515L4.073 8.732h2.67Zm7.013 2.97h-.88v-.86h-.022c-.383.66-.947.99-1.692.99c-.548 0-.978-.146-1.29-.436c-.307-.29-.461-.675-.461-1.155c0-1.027.605-1.625 1.815-1.794l1.65-.23c0-.935-.379-1.403-1.134-1.403c-.663 0-1.26.226-1.794.677V6.59c.54-.344 1.164-.516 1.87-.516c1.292 0 1.938.684 1.938 2.052v3.577Zm-.88-2.782l-1.327.183c-.409.057-.717.159-.924.306c-.208.143-.312.399-.312.768c0 .268.095.489.285.66c.193.169.45.253.768.253a1.41 1.41 0 0 0 1.08-.457c.286-.308.43-.696.43-1.165V8.92Z"/></svg>']),
            elt("label", null, [this.reField, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M10.012 2h.976v3.113l2.56-1.557l.486.885L11.47 6l2.564 1.559l-.485.885l-2.561-1.557V10h-.976V6.887l-2.56 1.557l-.486-.885L9.53 6L6.966 4.441l.485-.885l2.561 1.557V2zM2 10h4v4H2v-4z" clip-rule="evenodd"/></svg>']),
            elt("label", null, [this.wordField, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="currentColor"><path fill-rule="evenodd" d="M0 11h1v2h14v-2h1v3H0v-3Z" clip-rule="evenodd"/><path d="M6.84 11h-.88v-.86h-.022c-.383.66-.947.989-1.692.989c-.548 0-.977-.145-1.289-.435c-.308-.29-.462-.675-.462-1.155c0-1.028.605-1.626 1.816-1.794l1.649-.23c0-.935-.378-1.403-1.134-1.403c-.662 0-1.26.226-1.794.677v-.902c.541-.344 1.164-.516 1.87-.516c1.292 0 1.938.684 1.938 2.052V11Zm-.88-2.782L4.633 8.4c-.408.058-.716.16-.924.307c-.208.143-.311.399-.311.768c0 .268.095.488.284.66c.194.168.45.253.768.253a1.41 1.41 0 0 0 1.08-.457c.286-.308.43-.696.43-1.165v-.548Zm3.388 1.987h-.022V11h-.88V2.857h.88v3.61h.021c.434-.73 1.068-1.096 1.902-1.096c.705 0 1.257.247 1.654.741c.401.49.602 1.15.602 1.977c0 .92-.224 1.658-.672 2.213c-.447.551-1.06.827-1.837.827c-.726 0-1.276-.308-1.649-.924Zm-.022-2.218v.768c0 .455.147.841.44 1.16c.298.315.674.473 1.128.473c.534 0 .951-.204 1.252-.613c.304-.408.456-.975.456-1.702c0-.613-.141-1.092-.424-1.44c-.283-.347-.666-.52-1.15-.52c-.511 0-.923.178-1.235.536c-.311.355-.467.8-.467 1.338Z"/></g></svg>']),
            ...view.state.readOnly ? [] : [
                elt("br"),
                this.replaceField,
                button("replace", () => replaceNext(view), ['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="m3.221 3.739l2.261 2.269L7.7 3.784l-.7-.7l-1.012 1.007l-.008-1.6a.523.523 0 0 1 .5-.526H8V1H6.48A1.482 1.482 0 0 0 5 2.489V4.1L3.927 3.033l-.706.706zm6.67 1.794h.01c.183.311.451.467.806.467c.393 0 .706-.168.94-.503c.236-.335.353-.78.353-1.333c0-.511-.1-.913-.301-1.207c-.201-.295-.488-.442-.86-.442c-.405 0-.718.194-.938.581h-.01V1H9v4.919h.89v-.386zm-.015-1.061v-.34c0-.248.058-.448.175-.601a.54.54 0 0 1 .445-.23a.49.49 0 0 1 .436.233c.104.154.155.368.155.643c0 .33-.056.587-.169.768a.524.524 0 0 1-.47.27a.495.495 0 0 1-.411-.211a.853.853 0 0 1-.16-.532zM9 12.769c-.256.154-.625.231-1.108.231c-.563 0-1.02-.178-1.369-.533c-.349-.355-.523-.813-.523-1.374c0-.648.186-1.158.56-1.53c.374-.376.875-.563 1.5-.563c.433 0 .746.06.94.179v.998a1.26 1.26 0 0 0-.792-.276c-.325 0-.583.1-.774.298c-.19.196-.283.468-.283.816c0 .338.09.603.272.797c.182.191.431.287.749.287c.282 0 .558-.092.828-.276v.946zM4 7L3 8v6l1 1h7l1-1V8l-1-1H4zm0 1h7v6H4V8z" clip-rule="evenodd"/></svg>']),
                button("replaceAll", () => replaceAll(view), ['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M11.6 2.677c.147-.31.356-.465.626-.465c.248 0 .44.118.573.353c.134.236.201.557.201.966c0 .443-.078.798-.235 1.067c-.156.268-.365.402-.627.402c-.237 0-.416-.125-.537-.374h-.008v.31H11V1h.593v1.677h.008zm-.016 1.1a.78.78 0 0 0 .107.426c.071.113.163.169.274.169c.136 0 .24-.072.314-.216c.075-.145.113-.35.113-.615c0-.22-.035-.39-.104-.514c-.067-.124-.164-.187-.29-.187c-.12 0-.219.062-.297.185a.886.886 0 0 0-.117.48v.272zM4.12 7.695L2 5.568l.662-.662l1.006 1v-1.51A1.39 1.39 0 0 1 5.055 3H7.4v.905H5.055a.49.49 0 0 0-.468.493l.007 1.5l.949-.944l.656.656l-2.08 2.085zM9.356 4.93H10V3.22C10 2.408 9.685 2 9.056 2c-.135 0-.285.024-.45.073a1.444 1.444 0 0 0-.388.167v.665c.237-.203.487-.304.75-.304c.261 0 .392.156.392.469l-.6.103c-.506.086-.76.406-.76.961c0 .263.061.473.183.631A.61.61 0 0 0 8.69 5c.29 0 .509-.16.657-.48h.009v.41zm.004-1.355v.193a.75.75 0 0 1-.12.436a.368.368 0 0 1-.313.17a.276.276 0 0 1-.22-.095a.38.38 0 0 1-.08-.248c0-.222.11-.351.332-.389l.4-.067zM7 12.93h-.644v-.41h-.009c-.148.32-.367.48-.657.48a.61.61 0 0 1-.507-.235c-.122-.158-.183-.368-.183-.63c0-.556.254-.876.76-.962l.6-.103c0-.313-.13-.47-.392-.47c-.263 0-.513.102-.75.305v-.665c.095-.063.224-.119.388-.167c.165-.049.315-.073.45-.073c.63 0 .944.407.944 1.22v1.71zm-.64-1.162v-.193l-.4.068c-.222.037-.333.166-.333.388c0 .1.027.183.08.248a.276.276 0 0 0 .22.095a.368.368 0 0 0 .312-.17c.08-.116.12-.26.12-.436zM9.262 13c.321 0 .568-.058.738-.173v-.71a.9.9 0 0 1-.552.207a.619.619 0 0 1-.5-.215c-.12-.145-.181-.345-.181-.598c0-.26.063-.464.189-.612a.644.644 0 0 1 .516-.223c.194 0 .37.069.528.207v-.749c-.129-.09-.338-.134-.626-.134c-.417 0-.751.14-1.001.422c-.249.28-.373.662-.373 1.148c0 .42.116.764.349 1.03c.232.267.537.4.913.4zM2 9l1-1h9l1 1v5l-1 1H3l-1-1V9zm1 0v5h9V9H3zm3-2l1-1h7l1 1v5l-1 1V7H6z" clip-rule="evenodd"/></svg>'])
            ],
            elt("button", {
                name: "close",
                onclick: () => closeSearchPanel(view),
                "aria-label": phrase(view, "close"),
                type: "button"
            }, ["×"])
        ]);
    }
    commit() {
        let query = new SearchQuery({
            search: this.searchField.value,
            caseSensitive: this.caseField.checked,
            regexp: this.reField.checked,
            wholeWord: this.wordField.checked,
            replace: this.replaceField.value,
        });
        if (!query.eq(this.query)) {
            this.query = query;
            this.view.dispatch({ effects: setSearchQuery.of(query) });
        }
    }
    keydown(e) {
        if (runScopeHandlers(this.view, e, "search-panel")) {
            e.preventDefault();
        }
        else if (e.keyCode == 13 && e.target == this.searchField) {
            e.preventDefault();
            (e.shiftKey ? findPrevious : findNext)(this.view);
        }
        else if (e.keyCode == 13 && e.target == this.replaceField) {
            e.preventDefault();
            replaceNext(this.view);
        }
    }
    update(update) {
        for (let tr of update.transactions)
            for (let effect of tr.effects) {
                if (effect.is(setSearchQuery) && !effect.value.eq(this.query))
                    this.setQuery(effect.value);
            }
    }
    setQuery(query) {
        this.query = query;
        this.searchField.value = query.search;
        this.replaceField.value = query.replace;
        this.caseField.checked = query.caseSensitive;
        this.reField.checked = query.regexp;
        this.wordField.checked = query.wholeWord;
    }
    mount() {
        this.searchField.select();
    }
    get pos() { return 80; }
    get top() { return this.view.state.facet(searchConfigFacet).top; }
}
function phrase(view, phrase) { return view.state.phrase(phrase); }
const AnnounceMargin = 30;
const Break = /[\s\.,:;?!]/;
function announceMatch(view, { from, to }) {
    let line = view.state.doc.lineAt(from), lineEnd = view.state.doc.lineAt(to).to;
    let start = Math.max(line.from, from - AnnounceMargin), end = Math.min(lineEnd, to + AnnounceMargin);
    let text = view.state.sliceDoc(start, end);
    if (start != line.from) {
        for (let i = 0; i < AnnounceMargin; i++)
            if (!Break.test(text[i + 1]) && Break.test(text[i])) {
                text = text.slice(i);
                break;
            }
    }
    if (end != lineEnd) {
        for (let i = text.length - 1; i > text.length - AnnounceMargin; i--)
            if (!Break.test(text[i - 1]) && Break.test(text[i])) {
                text = text.slice(0, i);
                break;
            }
    }
    return EditorView.announce.of(`${view.state.phrase("current match")}. ${text} ${view.state.phrase("on line")} ${line.number}.`);
}
const baseTheme = /*@__PURE__*/EditorView.baseTheme({
    ".cm-panel.cm-search": {
        padding: "2px 6px 4px",
        position: "relative",
        "& [name=close]": {
            position: "absolute",
            top: "0",
            right: "4px",
            backgroundColor: "inherit",
            border: "none",
            font: "inherit",
            padding: 0,
            margin: 0
        },
        "& input, & button, & label": {
            margin: ".2em .6em .2em 0"
        },
        "& input[type=checkbox]": {
            marginRight: ".2em"
        },
        "& label": {
            fontSize: "80%",
            whiteSpace: "pre"
        }
    },
    "&light .cm-searchMatch": { backgroundColor: "#ffff0054" },
    "&dark .cm-searchMatch": { backgroundColor: "#00ffff8a" },
    "&light .cm-searchMatch-selected": { backgroundColor: "#ff6a0054" },
    "&dark .cm-searchMatch-selected": { backgroundColor: "#ff00ff8a" }
});
const searchExtensions = [
    searchState,
    /*@__PURE__*/Prec.lowest(searchHighlighter),
    baseTheme
];

export { RegExpCursor, SearchCursor, SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, gotoLine, highlightSelectionMatches, openSearchPanel, replaceAll, replaceNext, search, searchKeymap, searchPanelOpen, selectMatches, selectNextOccurrence, selectSelectionMatches, setSearchQuery };
