/* tslint:disable */
/* eslint-disable */

/**
 * Handle to a running game. Keep it if you need to stop the game (e.g. on SPA navigation).
 */
export class Game {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Test hook (needs `data-debug`): corrupts this peer's console RAM to exercise desync repair.
     */
    debug_corrupt(): void;
    /**
     * Diagnostics as JSON. Per-frame state hashes are only recorded with `data-debug`.
     */
    debug_json(): string;
    /**
     * Test hook (needs `data-debug`): extra buttons OR-ed into this player's input.
     */
    debug_set_pad(pad: number): void;
    set_muted(muted: boolean): void;
    /**
     * Machine-readable status, e.g. `"playing"` (see the `bcoop:status` event).
     */
    status(): string;
    /**
     * Leave the room, close the connection and remove the UI. Safe to call more than once.
     */
    stop(): void;
}

/**
 * Mounts the game into the element with the given id, configured by its `data-*` attributes.
 */
export function mount(element_id: string): Game;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_game_free: (a: number, b: number) => void;
    readonly game_debug_corrupt: (a: number) => void;
    readonly game_debug_json: (a: number) => [number, number];
    readonly game_debug_set_pad: (a: number, b: number) => void;
    readonly game_set_muted: (a: number, b: number) => void;
    readonly game_status: (a: number) => [number, number];
    readonly game_stop: (a: number) => void;
    readonly mount: (a: number, b: number) => [number, number, number];
    readonly start: () => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___f64______true_: (a: number, b: number, c: number) => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___wasm_bindgen_27ac6c0ba1ac7ac1___JsValue__core_3f1dfa5f4c99aacb___result__Result_____wasm_bindgen_27ac6c0ba1ac7ac1___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__11: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__12: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__13: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
