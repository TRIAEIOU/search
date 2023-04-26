import * as _codemirror_state from '@codemirror/state';
import { Text, Extension, StateCommand, EditorState, SelectionRange, StateEffect } from '@codemirror/state';
import { Command, KeyBinding, EditorView, Panel } from '@codemirror/view';

declare class SearchCursor implements Iterator<{
    from: number;
    to: number;
}> {
    private test?;
    private iter;
    value: {
        from: number;
        to: number;
    };
    done: boolean;
    private matches;
    private buffer;
    private bufferPos;
    private bufferStart;
    private normalize;
    private query;
    constructor(text: Text, query: string, from?: number, to?: number, normalize?: (string: string) => string, test?: ((from: number, to: number, buffer: string, bufferPos: number) => boolean) | undefined);
    private peek;
    next(): this;
    nextOverlapping(): this;
    private match;
    [Symbol.iterator]: () => Iterator<{
        from: number;
        to: number;
    }>;
}

interface RegExpCursorOptions {
    ignoreCase?: boolean;
    test?: (from: number, to: number, match: RegExpExecArray) => boolean;
}
declare class RegExpCursor implements Iterator<{
    from: number;
    to: number;
    match: RegExpExecArray;
}> {
    private text;
    private to;
    private iter;
    private re;
    private test?;
    private curLine;
    private curLineStart;
    private matchPos;
    done: boolean;
    value: {
        from: number;
        to: number;
        match: RegExpExecArray;
    };
    constructor(text: Text, query: string, options?: RegExpCursorOptions, from?: number, to?: number);
    private getLine;
    private nextLine;
    next(): this;
    [Symbol.iterator]: () => Iterator<{
        from: number;
        to: number;
        match: RegExpExecArray;
    }>;
}

declare const gotoLine: Command;

type HighlightOptions = {
    highlightWordAroundCursor?: boolean;
    minSelectionLength?: number;
    maxMatches?: number;
    wholeWords?: boolean;
};
declare function highlightSelectionMatches(options?: HighlightOptions): Extension;
declare const selectNextOccurrence: StateCommand;

interface SearchConfig {
    top?: boolean;
    caseSensitive?: boolean;
    literal?: boolean;
    regexp?: boolean;
    wholeWord?: boolean;
    createPanel?: (view: EditorView) => Panel;
    scrollToMatch?: (range: SelectionRange, view: EditorView) => StateEffect<unknown>;
}
declare function search(config?: SearchConfig): Extension;
declare class SearchQuery {
    readonly search: string;
    readonly caseSensitive: boolean;
    readonly literal: boolean;
    readonly regexp: boolean;
    readonly replace: string;
    readonly valid: boolean;
    readonly wholeWord: boolean;
    constructor(config: {
        search: string;
        caseSensitive?: boolean;
        literal?: boolean;
        regexp?: boolean;
        replace?: string;
        wholeWord?: boolean;
    });
    eq(other: SearchQuery): boolean;
    getCursor(state: EditorState | Text, from?: number, to?: number): Iterator<{
        from: number;
        to: number;
    }>;
}
declare const setSearchQuery: _codemirror_state.StateEffectType<SearchQuery>;
declare function getSearchQuery(state: EditorState): SearchQuery;
declare function searchPanelOpen(state: EditorState): boolean;
declare const findNext: Command;
declare const findPrevious: Command;
declare const selectMatches: Command;
declare const selectSelectionMatches: StateCommand;
declare const replaceNext: Command;
declare const replaceAll: Command;
declare const openSearchPanel: Command;
declare const closeSearchPanel: Command;
declare const searchKeymap: readonly KeyBinding[];

export { RegExpCursor, SearchCursor, SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, gotoLine, highlightSelectionMatches, openSearchPanel, replaceAll, replaceNext, search, searchKeymap, searchPanelOpen, selectMatches, selectNextOccurrence, selectSelectionMatches, setSearchQuery };
