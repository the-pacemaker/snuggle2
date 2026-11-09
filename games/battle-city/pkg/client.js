/* @ts-self-types="./client.d.ts" */

// Battle City Pause & Keepalive Coordination State
if (typeof window !== 'undefined') {
    window.__bc_state = window.__bc_state || {
        isLocalInactive: false,
        isPeerPaused: false,
        pendingRafCb: null,
        inputChannel: null,
        controlChannel: null,
        pauseChannel: null,
        pc: null,
        lastAck: 0,
        lastStart: 0,
        lastHello: null,
        gameStarted: false,
        keepaliveIntervalId: null,
    };

    window.__bc_make_keepalive_packet = function(ack, start) {
        const buf = new Uint8Array(21);
        const view = new DataView(buf.buffer);
        buf[0] = 1; // TAG_INPUT
        buf[1] = 0; // flags (no echo)
        view.setUint32(2, (ack || 0) >>> 0, true);
        view.setUint32(6, (start || 0) >>> 0, true);
        buf[10] = 0; // 0 inputs
        const now = Math.floor(performance.now()) >>> 0;
        view.setUint32(11, now, true); // ts
        view.setUint32(15, 0, true);
        view.setUint16(19, 0, true);
        return buf;
    };

    window.__bc_send_keepalive = function() {
        const st = window.__bc_state;
        if (!st) return;
        // CRITICAL: When the game is actively running, WASM already transmits real inputs 60 frames/sec.
        // Injecting artificial 0-input packets into an active netplay stream causes desyncs on real Wi-Fi networks!
        // ONLY send keepalives during handshaking (before gameStarted) or when locally inactive or peer-paused.
        const shouldSend = !st.gameStarted || st.isLocalInactive || st.isPeerPaused;
        if (!shouldSend) return;

        const inChan = st.inputChannel;
        if (inChan && inChan.readyState === 'open') {
            const pkt = window.__bc_make_keepalive_packet(st.lastAck, st.lastStart);
            try {
                inChan.send(pkt);
            } catch (_) {}
        }
        const ctlChan = st.controlChannel;
        if (ctlChan && ctlChan.readyState === 'open' && st.lastHello && !st.gameStarted) {
            try {
                ctlChan.send(st.lastHello);
            } catch (_) {}
        }
    };

    // Continuous heartbeat loop to ensure the connection NEVER loses contact
    if (!window.__bc_state.keepaliveIntervalId) {
        window.__bc_state.keepaliveIntervalId = setInterval(() => {
            if (window.__bc_send_keepalive) {
                window.__bc_send_keepalive();
            }
        }, 500);
    }

    window.__bc_is_game_paused = function() {
        return !!(window.__bc_state && (window.__bc_state.isLocalInactive || window.__bc_state.isPeerPaused));
    };

    window.__bc_resume_raf = function() {
        const st = window.__bc_state;
        if (st && st.pendingRafCb && !window.__bc_is_game_paused()) {
            const cb = st.pendingRafCb;
            st.pendingRafCb = null;
            requestAnimationFrame(cb);
        }
    };

    window.__bc_flush_pending_signals = function() {
        if (window.__bc_pending_welcome) {
            const pw = window.__bc_pending_welcome;
            window.__bc_pending_welcome = null;
            const s = typeof window.__bc_selected_slot === 'number' ? window.__bc_selected_slot : pw.parsed.slot;
            pw.parsed.slot = s;
            const hasPeer = !!(window.__bc_state && window.__bc_state.peerPresent) || !!pw.parsed.peer_present;
            pw.parsed.peer_present = hasPeer;
            window.__bc_state = window.__bc_state || {};
            window.__bc_state.localSlot = s;
            try { pw.cb.call(pw.target, new MessageEvent('message', { data: JSON.stringify(pw.parsed) })); } catch (_) {}
        }
        if (window.__bc_pending_outgoing_signals && window.__bc_pending_outgoing_signals.length > 0) {
            for (const item of window.__bc_pending_outgoing_signals) {
                try { item.ws.send(item.raw); } catch (_) {}
            }
            window.__bc_pending_outgoing_signals = [];
        }
        if (window.__bc_pending_incoming_signals && window.__bc_pending_incoming_signals.length > 0) {
            const incoming = window.__bc_pending_incoming_signals;
            window.__bc_pending_incoming_signals = [];
            setTimeout(() => {
                for (const item of incoming) {
                    try { item.cb.call(item.target, item.event); } catch (_) {}
                }
            }, 30);
        }
    };
}

/**
 * Handle to a running game. Keep it if you need to stop the game (e.g. on SPA navigation).
 */
export class Game {
    static __wrap(ptr) {
        const obj = Object.create(Game.prototype);
        obj.__wbg_ptr = ptr;
        GameFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GameFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_game_free(ptr, 0);
    }
    /**
     * Test hook (needs `data-debug`): corrupts this peer's console RAM to exercise desync repair.
     */
    debug_corrupt() {
        wasm.game_debug_corrupt(this.__wbg_ptr);
    }
    /**
     * Diagnostics as JSON. Per-frame state hashes are only recorded with `data-debug`.
     * @returns {string}
     */
    debug_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.game_debug_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Test hook (needs `data-debug`): extra buttons OR-ed into this player's input.
     * @param {number} pad
     */
    debug_set_pad(pad) {
        wasm.game_debug_set_pad(this.__wbg_ptr, pad);
    }
    /**
     * @param {boolean} muted
     */
    set_muted(muted) {
        wasm.game_set_muted(this.__wbg_ptr, muted);
    }
    /**
     * Machine-readable status, e.g. `"playing"` (see the `bcoop:status` event).
     * @returns {string}
     */
    status() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.game_status(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Leave the room, close the connection and remove the UI. Safe to call more than once.
     */
    stop() {
        wasm.game_stop(this.__wbg_ptr);
    }
}
if (Symbol.dispose) Game.prototype[Symbol.dispose] = Game.prototype.free;

/**
 * Mounts the game into the element with the given id, configured by its `data-*` attributes.
 * @param {string} element_id
 * @returns {Game}
 */
export function mount(element_id) {
    const ptr0 = passStringToWasm0(element_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.mount(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Game.__wrap(ret[0]);
}

export function start() {
    wasm.start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_debug_string_4687d8d8c2017d52: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_dcc1a90847f04c41: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_addEventListener_4d0db17c671ea324: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_addIceCandidate_ffa365a6618ce5bd: function(arg0, arg1) {
            const ret = arg0.addIceCandidate(arg1);
            try {
                if (arg1 && arg1.candidate && arg1.candidate.includes('.local')) {
                    const host = typeof location !== 'undefined' ? location.hostname : '';
                    if (host && host !== 'localhost' && /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) {
                        const patchedCand = arg1.candidate.replace(/([a-zA-Z0-9-]+\.local)/g, host);
                        const copy = {
                            candidate: patchedCand,
                            sdpMid: arg1.sdpMid,
                            sdpMLineIndex: arg1.sdpMLineIndex,
                            usernameFragment: arg1.usernameFragment
                        };
                        arg0.addIceCandidate(copy).catch(() => {});
                    }
                }
            } catch (_) {}
            return ret;
        },
        __wbg_add_9ceab44da1353b80: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.add(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_altKey_cfb4c4fab9a7d0d0: function(arg0) {
            const ret = arg0.altKey;
            return ret;
        },
        __wbg_appendChild_fb8c52e7dd8484ea: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.appendChild(arg1);
            return ret;
        }, arguments); },
        __wbg_arrayBuffer_0fe6e1300abcf908: function(arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        },
        __wbg_arrayBuffer_f07be74819944ea2: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_axes_1544d2030f316eff: function(arg0) {
            const ret = arg0.axes;
            return ret;
        },
        __wbg_bufferedAmount_ffae037ee3ccb36c: function(arg0) {
            const ret = arg0.bufferedAmount;
            return ret;
        },
        __wbg_buttons_d32d3eb4f6cb5c35: function(arg0) {
            const ret = arg0.buttons;
            return ret;
        },
        __wbg_cancelAnimationFrame_6d30ac112c49342a: function() { return handleError(function (arg0, arg1) {
            arg0.cancelAnimationFrame(arg1);
        }, arguments); },
        __wbg_candidate_1b46fc7e7e09ff36: function(arg0) {
            const ret = arg0.candidate;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_candidate_4706058d90edd65c: function(arg0, arg1) {
            const ret = arg1.candidate;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_classList_8a097a4837412bf6: function(arg0) {
            const ret = arg0.classList;
            return ret;
        },
        __wbg_clearInterval_f1a050672da2658c: function(arg0, arg1) {
            arg0.clearInterval(arg1);
        },
        __wbg_close_35c28c04c6854ad8: function(arg0) {
            arg0.close();
        },
        __wbg_close_d3ed56b5763be5ae: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_d6be50a702eae8fc: function() { return handleError(function (arg0) {
            const ret = arg0.close();
            return ret;
        }, arguments); },
        __wbg_close_de72eca08cf70e9c: function(arg0) {
            arg0.close();
        },
        __wbg_code_422d539f5d7bacbb: function(arg0, arg1) {
            const ret = arg1.code;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_connect_30bfff6aec59fc83: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.connect(arg1);
            return ret;
        }, arguments); },
        __wbg_connected_5a26e8e31af93dbc: function(arg0) {
            const ret = arg0.connected;
            return ret;
        },
        __wbg_connectionState_ab1e320e4aaa25d6: function(arg0) {
            const ret = arg0.connectionState;
            // On mobile Wi-Fi, connectionState often briefly dips into 'disconnected' during power-saving or roaming.
            // In WebRTC, 'disconnected' is a transient recovery state, whereas 'failed' is terminal.
            // Give WebRTC 8 seconds to recover before reporting 'disconnected' to WASM as a fatal drop.
            if (ret === 'disconnected' && !window.__bc_state?.isPermanentlyDisconnected) {
                if (!window.__bc_state._dcTimer) {
                    window.__bc_state._dcTimer = setTimeout(() => {
                        if (window.__bc_state) window.__bc_state.isPermanentlyDisconnected = true;
                    }, 8000);
                }
                return (__wbindgen_enum_RtcPeerConnectionState.indexOf('connected') + 1 || 7) - 1;
            }
            if (ret === 'connected') {
                if (window.__bc_state?._dcTimer) {
                    clearTimeout(window.__bc_state._dcTimer);
                    window.__bc_state._dcTimer = null;
                }
                if (window.__bc_state) window.__bc_state.isPermanentlyDisconnected = false;
            }
            return (__wbindgen_enum_RtcPeerConnectionState.indexOf(ret) + 1 || 7) - 1;
        },
        __wbg_copyToChannel_459cca8c62b0e606: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.copyToChannel(getArrayF32FromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_createAnswer_4565390027b78031: function(arg0) {
            const ret = arg0.createAnswer();
            return ret;
        },
        __wbg_createBufferSource_2cbe6214f761dfcb: function() { return handleError(function (arg0) {
            const ret = arg0.createBufferSource();
            return ret;
        }, arguments); },
        __wbg_createBuffer_41ea68f490cd6844: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.createBuffer(arg1 >>> 0, arg2 >>> 0, arg3);
            return ret;
        }, arguments); },
        __wbg_createDataChannel_83caaab3b3db15e4: function(arg0, arg1, arg2, arg3) {
            const label = getStringFromWasm0(arg1, arg2);
            const ret = arg0.createDataChannel(label, arg3);
            if (typeof window !== 'undefined' && window.__bc_state) {
                if (label === 'input') {
                    window.__bc_state.inputChannel = ret;
                    ret.addEventListener('open', () => {
                        if (window.__bc_send_keepalive) window.__bc_send_keepalive();
                    });
                } else if (label === 'control') {
                    window.__bc_state.controlChannel = ret;
                    ret.addEventListener('open', () => {
                        if (window.__bc_send_keepalive) window.__bc_send_keepalive();
                    });
                }
                if (!window.__bc_state.pc) {
                    window.__bc_state.pc = arg0;
                    try {
                        const pauseChan = arg0.createDataChannel('snuggle_pause', { negotiated: true, id: 2 });
                        pauseChan.onmessage = (e) => {
                            try {
                                const msg = JSON.parse(e.data);
                                if (window.__bc_on_pause_message) {
                                    window.__bc_on_pause_message(msg);
                                }
                            } catch (_) {}
                        };
                        window.__bc_state.pauseChannel = pauseChan;
                    } catch (err) {
                        console.warn('[Battle City] Error creating pause channel:', err);
                    }
                }
            }
            return ret;
        },
        __wbg_createElement_74049073a11f9c31: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.createElement(getStringFromWasm0(arg1, arg2));
            return ret;
        }, arguments); },
        __wbg_createGain_b6551e1ad1609779: function() { return handleError(function (arg0) {
            const ret = arg0.createGain();
            return ret;
        }, arguments); },
        __wbg_createOffer_419e0ee0d8a14451: function(arg0) {
            const ret = arg0.createOffer();
            return ret;
        },
        __wbg_ctrlKey_8b5101745e8782fa: function(arg0) {
            const ret = arg0.ctrlKey;
            return ret;
        },
        __wbg_currentTime_eb1592316a1d4450: function(arg0) {
            const ret = arg0.currentTime;
            return ret;
        },
        __wbg_data_522f7abc70721269: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_destination_05471d87031cba86: function(arg0) {
            const ret = arg0.destination;
            return ret;
        },
        __wbg_dispatchEvent_57e1a8af186ff471: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.dispatchEvent(arg1);
            return ret;
        }, arguments); },
        __wbg_document_9854e03c05fc8834: function(arg0) {
            const ret = arg0.document;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_fetch_4178962c570137ca: function(arg0, arg1, arg2) {
            const ret = arg0.fetch(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_files_cb1ce1b82f16c484: function(arg0) {
            const ret = arg0.files;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_fillRect_0ef59adb9acb7d06: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.fillRect(arg1, arg2, arg3, arg4);
        },
        __wbg_gain_29777386775059c0: function(arg0) {
            const ret = arg0.gain;
            return ret;
        },
        __wbg_getAttribute_061ad00c16e2f622: function(arg0, arg1, arg2, arg3) {
            const ret = arg1.getAttribute(getStringFromWasm0(arg2, arg3));
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getContext_635e36719cad2623: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getElementById_cc94972b404e4eaa: function(arg0, arg1, arg2) {
            const ret = arg0.getElementById(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getGamepads_912bbd8a90a857f7: function() { return handleError(function (arg0) {
            const ret = arg0.getGamepads();
            return ret;
        }, arguments); },
        __wbg_getItem_4c80b7663197c7ff: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg1.getItem(getStringFromWasm0(arg2, arg3));
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            let ret = Reflect.get(arg0, arg1);
            if (ret === undefined && typeof arg1 === 'string' && arg1.includes('-')) {
                const camel = arg1.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                ret = Reflect.get(arg0, camel);
            }
            return ret;
        }, arguments); },
        __wbg_get_5dde8a29f073d908: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_head_37fa26d1df5b82da: function(arg0) {
            const ret = arg0.head;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_hidden_2ba371ecafe013fa: function(arg0) {
            const ret = arg0.hidden;
            return ret;
        },
        __wbg_host_75aa3342c78db1a2: function() { return handleError(function (arg0, arg1) {
            const ret = arg1.host;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_CanvasRenderingContext2d_769208c72dcbf5e6: function(arg0) {
            let result;
            try {
                result = arg0 instanceof CanvasRenderingContext2D;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Element_818e11074cdb63b5: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Element;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_GamepadButton_194af99e75be79f5: function(arg0) {
            let result;
            try {
                result = arg0 instanceof GamepadButton;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Gamepad_379e1510b278c518: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Gamepad;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlButtonElement_bd67486d3501ad48: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLButtonElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlCanvasElement_0a30c11fbbf41841: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLCanvasElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlElement_32fb153a5a0e2349: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlInputElement_5c33d1de59c09c49: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLInputElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_KeyboardEvent_0176f04c0ee63f6d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof KeyboardEvent;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_b8758567269c30b2: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_82d71df4eddf88bc: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isContentEditable_9045d8176bc559f8: function(arg0) {
            const ret = arg0.isContentEditable;
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_localStorage_567c24950edbc178: function() { return handleError(function (arg0) {
            const ret = arg0.localStorage;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_location_9c46e8ada95d3174: function(arg0) {
            const ret = arg0.location;
            return ret;
        },
        __wbg_metaKey_fb78da4d237d5bbb: function(arg0) {
            const ret = arg0.metaKey;
            return ret;
        },
        __wbg_navigator_2156486643462a87: function(arg0) {
            const ret = arg0.navigator;
            return ret;
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_4059fb0406225e04: function() { return handleError(function (arg0, arg1) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
            if (typeof window !== 'undefined') {
                window.__bc_state = window.__bc_state || {};
                window.__bc_state.ws = ret;
                window.__bc_broadcast_slot = function(slot) {
                    if (ret && ret.readyState === WebSocket.OPEN) {
                        try {
                            ret.send(JSON.stringify({ type: 'signal', data: { type: 'slot_choice', slot } }));
                        } catch (_) {}
                    }
                };
                window.__bc_broadcast_start = function() {
                    if (ret && ret.readyState === WebSocket.OPEN) {
                        try {
                            ret.send(JSON.stringify({ type: 'signal', data: { type: 'start_game', kind: 'start_game' } }));
                        } catch (_) {}
                    }
                };
            }
            return ret;
        }, arguments); },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_afd97fa36645d359: function() { return handleError(function () {
            const ret = new lAudioContext();
            if (typeof window !== 'undefined') {
                window.__bc_audio_ctx = ret;
                if (window.__bc_audio_muted) {
                    try { ret.suspend(); } catch (_) {}
                }
            }
            return ret;
        }, arguments); },
        __wbg_new_with_configuration_c6d3ab433d0adb73: function() { return handleError(function (arg0) {
            const ret = new RTCPeerConnection(arg0);
            return ret;
        }, arguments); },
        __wbg_new_with_event_init_dict_536cb65c14ffc56b: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new CustomEvent(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_u8_clamped_array_and_sh_af3f0dee40638e18: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = new ImageData(getClampedArrayU8FromWasm0(arg0, arg1), arg2 >>> 0, arg3 >>> 0);
            return ret;
        }, arguments); },
        __wbg_now_d0b7f4bea9f38490: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_ok_125878a7db256ecb: function(arg0) {
            const ret = arg0.ok;
            return ret;
        },
        __wbg_parse_0fc53dead14b3b42: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_performance_d0d7b03fc649b694: function(arg0) {
            const ret = arg0.performance;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_pressed_e774166b0a6c08fc: function(arg0) {
            const ret = arg0.pressed;
            return ret;
        },
        __wbg_preventDefault_af59afb0f0a02e20: function(arg0) {
            arg0.preventDefault();
        },
        __wbg_protocol_c29b929bd710072b: function() { return handleError(function (arg0, arg1) {
            const ret = arg1.protocol;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_putImageData_11570c06086c9e05: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.putImageData(arg1, arg2, arg3);
        }, arguments); },
        __wbg_queueMicrotask_9833f9a49df95a49: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_a72f977e97f23c5f: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_readyState_418637f3ca14e818: function(arg0) {
            const ret = arg0.readyState;
            return (__wbindgen_enum_RtcDataChannelState.indexOf(ret) + 1 || 5) - 1;
        },
        __wbg_readyState_d8514376867e415b: function(arg0) {
            const ret = arg0.readyState;
            return ret;
        },
        __wbg_removeEventListener_6e68185345978771: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_remove_1013622eead8b586: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.remove(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_requestAnimationFrame_7b526ab7aa550c74: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.requestAnimationFrame(arg1);
            return ret;
        }, arguments); },
        __wbg_requestFullscreen_4eb8242c77c753fd: function() { return handleError(function (arg0) {
            if (typeof window !== 'undefined' && typeof window.__bc_toggle_fullscreen === 'function') {
                window.__bc_toggle_fullscreen(arg0);
            } else if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                arg0.requestFullscreen();
            }
        }, arguments); },
        __wbg_resolve_0076e10020304ede: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_resume_262977d0e323b264: function() { return handleError(function (arg0) {
            if (typeof window !== 'undefined' && window.__bc_audio_muted) {
                return Promise.resolve();
            }
            const ret = arg0.resume();
            return ret;
        }, arguments); },
        __wbg_sdpMLineIndex_0ea38020cdf6d80b: function(arg0) {
            const ret = arg0.sdpMLineIndex;
            return isLikeNone(ret) ? 0xFFFFFF : ret;
        },
        __wbg_sdpMid_d5987403d70d0bb8: function(arg0, arg1) {
            const ret = arg1.sdpMid;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_send_1e2ed35a61efd7fd: function() { return handleError(function (arg0, arg1, arg2) {
            const data = getArrayU8FromWasm0(arg1, arg2);
            if (typeof window !== 'undefined' && window.__bc_state && data) {
                if (data[0] === 1 && data.length >= 21) {
                    window.__bc_state.lastAck = data[2] | (data[3] << 8) | (data[4] << 16) | (data[5] << 24);
                    window.__bc_state.lastStart = data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24);
                    window.__bc_state.gameStarted = true;
                }
                if (arg0 === window.__bc_state.controlChannel && data[0] === 1) {
                    window.__bc_state.lastHello = new Uint8Array(data);
                }
            }
            arg0.send(data);
        }, arguments); },
        __wbg_send_b5bdd806efe4baf6: function() { return handleError(function (arg0, arg1, arg2) {
            const raw = getStringFromWasm0(arg1, arg2);

            // Hold WebRTC offer/answer/candidates until both peers have confirmed different slots
            if (raw.includes('"offer"') || raw.includes('"answer"') || raw.includes('"candidate"') || raw.includes('"ice"')) {
                if (typeof window !== 'undefined' && !window.__bc_slots_confirmed) {
                    window.__bc_pending_outgoing_signals = window.__bc_pending_outgoing_signals || [];
                    window.__bc_pending_outgoing_signals.push({ ws: arg0, raw });
                    return;
                }
            }

            arg0.send(raw);

            // If an ICE candidate contains an mDNS .local UUID, also send an augmented copy
            // using the host's LAN IP so mobile phones without mDNS resolvers can connect directly!
            try {
                if (raw.includes('"ice"') && raw.includes('.local')) {
                    const host = typeof location !== 'undefined' ? location.hostname : '';
                    if (host && host !== 'localhost' && /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) {
                        const augmented = raw.replace(/([a-zA-Z0-9-]+\.local)/g, host);
                        if (augmented !== raw) {
                            setTimeout(() => {
                                try { arg0.send(augmented); } catch (_) {}
                            }, 15);
                        }
                    }
                }
            } catch (_) {}
        }, arguments); },
        __wbg_setAttribute_9e7d603908f63705: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setAttribute(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_setInterval_aa4e3d3f590ce835: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setInterval(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_setItem_c5fb0966b484ecd3: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.setItem(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_setLocalDescription_c44231625d771b55: function(arg0, arg1) {
            const ret = arg0.setLocalDescription(arg1);
            return ret;
        },
        __wbg_setRemoteDescription_a8fe607f1eef503d: function(arg0, arg1) {
            const ret = arg0.setRemoteDescription(arg1);
            return ret;
        },
        __wbg_setTimeout_db7bbc18a17e152a: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_accept_06d626c479e21e36: function(arg0, arg1, arg2) {
            arg0.accept = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_binaryType_9a9ed83755a2cba4: function(arg0, arg1) {
            arg0.binaryType = __wbindgen_enum_RtcDataChannelType[arg1];
        },
        __wbg_set_bubbles_13637ca47f23465d: function(arg0, arg1) {
            arg0.bubbles = arg1 !== 0;
        },
        __wbg_set_buffer_7ab48e13895631dc: function(arg0, arg1) {
            arg0.buffer = arg1;
        },
        __wbg_set_candidate_74317261cf6d6fef: function(arg0, arg1, arg2) {
            arg0.candidate = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_className_541fce5cd31918aa: function(arg0, arg1, arg2) {
            arg0.className = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_detail_69a5bfecc90520f4: function(arg0, arg1) {
            arg0.detail = arg1;
        },
        __wbg_set_fillStyle_a2961b4d44e572af: function(arg0, arg1, arg2) {
            arg0.fillStyle = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_height_c9789c1c77eaedff: function(arg0, arg1) {
            arg0.height = arg1 >>> 0;
        },
        __wbg_set_hidden_a331cae3e6ef7f9c: function(arg0, arg1) {
            arg0.hidden = arg1 !== 0;
        },
        __wbg_set_ice_servers_0e993347b54c4c75: function(arg0, arg1) {
            arg0.iceServers = arg1;
        },
        __wbg_set_id_60955e6018d03b26: function(arg0, arg1, arg2) {
            arg0.id = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_id_be1645a951dfb369: function(arg0, arg1) {
            arg0.id = arg1;
        },
        __wbg_set_imageSmoothingEnabled_eb22252b69819404: function(arg0, arg1) {
            arg0.imageSmoothingEnabled = arg1 !== 0;
        },
        __wbg_set_innerHTML_7af59a832a09a074: function(arg0, arg1, arg2) {
            arg0.innerHTML = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_max_retransmits_8c9e61eaf9d25b82: function(arg0, arg1) {
            arg0.maxRetransmits = arg1;
        },
        __wbg_set_negotiated_48c0e4fe09dd514b: function(arg0, arg1) {
            arg0.negotiated = arg1 !== 0;
        },
        __wbg_set_onclose_a84370531f3d2948: function(arg0, arg1) {
            arg0.onclose = arg1;
        },
        __wbg_set_onclose_bb8c0565a5c25837: function(arg0, arg1) {
            arg0.onclose = arg1;
        },
        __wbg_set_onconnectionstatechange_9c3cc97053cc8cc7: function(arg0, arg1) {
            arg0.onconnectionstatechange = arg1;
        },
        __wbg_set_onerror_94ee307653399172: function(arg0, arg1) {
            arg0.onerror = arg1;
        },
        __wbg_set_onicecandidate_d5e1ae20949a49ef: function(arg0, arg1) {
            arg0.onicecandidate = arg1;
        },
        __wbg_set_onmessage_b1a84cbc1fe48890: function(arg0, arg1) {
            if (typeof WebSocket !== 'undefined' && arg0 instanceof WebSocket) {
                const origCb = arg1;
                arg0.onmessage = function(e) {
                    if (typeof window !== 'undefined') {
                        try {
                            const parsed = JSON.parse(e.data);
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'slot_choice' || parsed.data.kind === 'slot_choice')) {
                                window.__bc_peer_selected_slot = parsed.data.slot;
                                window.dispatchEvent(new CustomEvent('bc:peer_slot_choice', { detail: { slot: parsed.data.slot } }));
                                return;
                            }
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'start_game' || parsed.data.kind === 'start_game')) {
                                window.dispatchEvent(new CustomEvent('bc:peer_start_game'));
                                return;
                            }
                            if (parsed.type === 'welcome') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = !!parsed.peer_present;
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: !!parsed.peer_present } }));
                                if (parsed.peer_present && typeof window.__bc_selected_slot === 'number') {
                                    window.__bc_broadcast_slot?.(window.__bc_selected_slot);
                                }
                                if (!window.__bc_slots_confirmed) {
                                    window.__bc_pending_welcome = { target: this, parsed, cb: origCb };
                                    return;
                                }
                                const s = typeof window.__bc_selected_slot === 'number' ? window.__bc_selected_slot : parsed.slot;
                                parsed.slot = s;
                                window.__bc_state.localSlot = s;
                                return origCb.call(this, new MessageEvent('message', { data: JSON.stringify(parsed) }));
                            }
                            if (parsed.type === 'peer_joined') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = true;
                                if (window.__bc_pending_welcome) {
                                    window.__bc_pending_welcome.parsed.peer_present = true;
                                }
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: true } }));
                                if (typeof window.__bc_selected_slot === 'number') {
                                    window.__bc_broadcast_slot?.(window.__bc_selected_slot);
                                }
                                if (window.__bc_slots_confirmed) {
                                    return origCb.call(this, e);
                                }
                                return;
                            }
                            if (parsed.type === 'peer_left') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = false;
                                window.__bc_peer_selected_slot = null;
                                window.__bc_slots_confirmed = false;
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: false } }));
                                window.dispatchEvent(new CustomEvent('bc:peer_slot_choice', { detail: { slot: null } }));
                            }
                            if (parsed.type === 'error' && parsed.code === 'preempted') {
                                if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
                                    window.parent.postMessage({ type: 'bc:solo_preempted' }, '*');
                                }
                                return;
                            }
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'offer' || parsed.data.type === 'answer' || parsed.data.candidate || parsed.data.type === 'ice')) {
                                if (!window.__bc_slots_confirmed) {
                                    window.__bc_pending_incoming_signals = window.__bc_pending_incoming_signals || [];
                                    window.__bc_pending_incoming_signals.push({ target: this, event: e, cb: origCb });
                                    return;
                                }
                            }
                        } catch (_) {}
                    }
                    return origCb.call(this, e);
                };
                return;
            }
            arg0.onmessage = arg1;
        },
        __wbg_set_onmessage_cb6f77d2d8e0402a: function(arg0, arg1) {
            if (typeof WebSocket !== 'undefined' && arg0 instanceof WebSocket) {
                const origCb = arg1;
                arg0.onmessage = function(e) {
                    if (typeof window !== 'undefined') {
                        try {
                            const parsed = JSON.parse(e.data);
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'slot_choice' || parsed.data.kind === 'slot_choice')) {
                                window.__bc_peer_selected_slot = parsed.data.slot;
                                window.dispatchEvent(new CustomEvent('bc:peer_slot_choice', { detail: { slot: parsed.data.slot } }));
                                return;
                            }
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'start_game' || parsed.data.kind === 'start_game')) {
                                window.dispatchEvent(new CustomEvent('bc:peer_start_game'));
                                return;
                            }
                            if (parsed.type === 'welcome') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = !!parsed.peer_present;
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: !!parsed.peer_present } }));
                                if (parsed.peer_present && typeof window.__bc_selected_slot === 'number') {
                                    window.__bc_broadcast_slot?.(window.__bc_selected_slot);
                                }
                                if (!window.__bc_slots_confirmed) {
                                    window.__bc_pending_welcome = { target: this, parsed, cb: origCb };
                                    return;
                                }
                                const s = typeof window.__bc_selected_slot === 'number' ? window.__bc_selected_slot : parsed.slot;
                                parsed.slot = s;
                                window.__bc_state.localSlot = s;
                                return origCb.call(this, new MessageEvent('message', { data: JSON.stringify(parsed) }));
                            }
                            if (parsed.type === 'peer_joined') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = true;
                                if (window.__bc_pending_welcome) {
                                    window.__bc_pending_welcome.parsed.peer_present = true;
                                }
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: true } }));
                                if (typeof window.__bc_selected_slot === 'number') {
                                    window.__bc_broadcast_slot?.(window.__bc_selected_slot);
                                }
                                if (window.__bc_slots_confirmed) {
                                    return origCb.call(this, e);
                                }
                                return;
                            }
                            if (parsed.type === 'peer_left') {
                                window.__bc_state = window.__bc_state || {};
                                window.__bc_state.peerPresent = false;
                                window.__bc_peer_selected_slot = null;
                                window.__bc_slots_confirmed = false;
                                window.dispatchEvent(new CustomEvent('bc:peer_presence', { detail: { present: false } }));
                                window.dispatchEvent(new CustomEvent('bc:peer_slot_choice', { detail: { slot: null } }));
                            }
                            if (parsed.type === 'error' && parsed.code === 'preempted') {
                                if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
                                    window.parent.postMessage({ type: 'bc:solo_preempted' }, '*');
                                }
                                return;
                            }
                            if (parsed.type === 'signal' && parsed.data && (parsed.data.type === 'offer' || parsed.data.type === 'answer' || parsed.data.candidate || parsed.data.type === 'ice')) {
                                if (!window.__bc_slots_confirmed) {
                                    window.__bc_pending_incoming_signals = window.__bc_pending_incoming_signals || [];
                                    window.__bc_pending_incoming_signals.push({ target: this, event: e, cb: origCb });
                                    return;
                                }
                            }
                        } catch (_) {}
                    }
                    return origCb.call(this, e);
                };
                return;
            }
            arg0.onmessage = arg1;
        },
        __wbg_set_onopen_6cc40bb77c7d158d: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbg_set_onopen_c914147e8a2db4b0: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbg_set_ordered_c53f7b89fc9fb3b8: function(arg0, arg1) {
            arg0.ordered = arg1 !== 0;
        },
        __wbg_set_sdp_efdff02bfd21fa09: function(arg0, arg1, arg2) {
            arg0.sdp = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_sdp_m_line_index_90d020b194b40483: function(arg0, arg1) {
            arg0.sdpMLineIndex = arg1 === 0xFFFFFF ? undefined : arg1;
        },
        __wbg_set_sdp_mid_629236bd379fcb1e: function(arg0, arg1, arg2) {
            arg0.sdpMid = arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_tabIndex_6999832ea5d5197e: function(arg0, arg1) {
            arg0.tabIndex = arg1;
        },
        __wbg_set_textContent_6d6fc559f198055f: function(arg0, arg1, arg2) {
            let str = arg1 === 0 ? undefined : getStringFromWasm0(arg1, arg2);
            if (str && typeof str === 'string') {
                if (typeof window !== 'undefined' && window.__bc_is_game_paused && window.__bc_is_game_paused()) {
                    str = '⏸️ GAME PAUSED';
                } else if (str.toLowerCase().includes('waiting') || str.includes('join room') || str.includes('peer') || str.includes('the other player')) {
                    str = 'Waiting…';
                }
            }
            arg0.textContent = str;
        },
        __wbg_set_title_e8d81f3c76851f8d: function(arg0, arg1, arg2) {
            arg0.title = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_type_19b6e3a56c3fa1f1: function(arg0, arg1, arg2) {
            arg0.type = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_type_6507077b45f3a9a5: function(arg0, arg1) {
            arg0.type = __wbindgen_enum_RtcSdpType[arg1];
        },
        __wbg_set_type_ced89392955280fa: function(arg0, arg1, arg2) {
            arg0.type = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_value_bf45a2dfcba57147: function(arg0, arg1) {
            arg0.value = arg1;
        },
        __wbg_set_value_fbd659f94bfb9181: function(arg0, arg1, arg2) {
            arg0.value = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_width_b0e1267db4b196b5: function(arg0, arg1) {
            arg0.width = arg1 >>> 0;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_start_6d670bddcbed7c75: function() { return handleError(function (arg0, arg1) {
            arg0.start(arg1);
        }, arguments); },
        __wbg_state_54551b9345fb007f: function(arg0) {
            const ret = arg0.state;
            return (__wbindgen_enum_AudioContextState.indexOf(ret) + 1 || 4) - 1;
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_ce0a98d3c57125f3: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_stringify_52ff602c1cc4fbb6: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_tagName_e83500df63beeee1: function(arg0, arg1) {
            const ret = arg1.tagName;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_target_38ae9feb025b820c: function(arg0) {
            const ret = arg0.target;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_then_c949d5a25a4e78f8: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_e71170d78fcf8954: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_toggle_40db1492f54c657f: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.toggle(getStringFromWasm0(arg1, arg2), arg3 !== 0);
            return ret;
        }, arguments); },
        __wbg_warn_13abc63e0d4b3527: function(arg0) {
            console.warn(arg0);
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 394, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___wasm_bindgen_27ac6c0ba1ac7ac1___JsValue__core_3f1dfa5f4c99aacb___result__Result_____wasm_bindgen_27ac6c0ba1ac7ac1___JsError___true_);
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [F64], shim_idx: 11, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___f64______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 4, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("Event")], shim_idx: 4, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__11);
            return ret;
        },
        __wbindgen_generic_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 4, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__12);
            return ret;
        },
        __wbindgen_generic_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("RTCPeerConnectionIceEvent")], shim_idx: 4, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__13);
            return ret;
        },
        __wbindgen_generic_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 1, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke_______true_);
            return ret;
        },
        __wbindgen_generic_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./client_bg.js": import0,
    };
}

const lAudioContext = (typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : undefined));
function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke_______true_(arg0, arg1) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke_______true_(arg0, arg1);
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true_(arg0, arg1, arg2);
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__11(arg0, arg1, arg2) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__11(arg0, arg1, arg2);
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__12(arg0, arg1, arg2) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__12(arg0, arg1, arg2);
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__13(arg0, arg1, arg2) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___web_sys_a349c0847b21e105___features__gen_CloseEvent__CloseEvent______true__13(arg0, arg1, arg2);
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___wasm_bindgen_27ac6c0ba1ac7ac1___JsValue__core_3f1dfa5f4c99aacb___result__Result_____wasm_bindgen_27ac6c0ba1ac7ac1___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___wasm_bindgen_27ac6c0ba1ac7ac1___JsValue__core_3f1dfa5f4c99aacb___result__Result_____wasm_bindgen_27ac6c0ba1ac7ac1___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___f64______true_(arg0, arg1, arg2) {
    wasm.wasm_bindgen_27ac6c0ba1ac7ac1___convert__closures_____invoke___f64______true_(arg0, arg1, arg2);
}


const __wbindgen_enum_AudioContextState = ["suspended", "running", "closed"];


const __wbindgen_enum_RtcDataChannelState = ["connecting", "open", "closing", "closed"];


const __wbindgen_enum_RtcDataChannelType = ["arraybuffer", "blob"];


const __wbindgen_enum_RtcPeerConnectionState = ["closed", "failed", "disconnected", "new", "connecting", "connected"];


const __wbindgen_enum_RtcSdpType = ["offer", "pranswer", "answer", "rollback"];
const GameFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_game_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getClampedArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ClampedArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedUint8ClampedArrayMemory0 = null;
function getUint8ClampedArrayMemory0() {
    if (cachedUint8ClampedArrayMemory0 === null || cachedUint8ClampedArrayMemory0.byteLength === 0) {
        cachedUint8ClampedArrayMemory0 = new Uint8ClampedArray(wasm.memory.buffer);
    }
    return cachedUint8ClampedArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    cachedUint8ClampedArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('client_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
