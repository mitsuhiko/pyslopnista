;; Minimal JSPI test module mirroring how Pyodide uses JSPI: exports are
;; wrapped with WebAssembly.promising() and called with a leading externref;
;; a single WebAssembly.Suspending import has the signature
;; (externref, externref) -> externref.
(module
  (type $susp_t (func (param externref externref) (result externref)))

  ;; WebAssembly.Suspending(async (x, y) => await (x ?? y))
  (import "env" "suspend" (func $suspend (type $susp_t)))
  ;; ordinary JS function that calls back into the wasm export "leaf"
  (import "env" "reenter" (func $reenter (param externref) (result externref)))
  ;; ordinary JS function that calls the wasm export "inner_suspend", which
  ;; suspends with a JS frame on the stack (must throw, not hang)
  (import "env" "call_inner_suspend" (func $call_inner_suspend (param externref externref) (result externref)))

  (memory (export "memory") 1)
  (table 1 funcref)
  (elem (i32.const 0) $suspend_thunk)

  (func $suspend_thunk (type $susp_t)
    (call $suspend (local.get 0) (local.get 1)))

  ;; promising export -> suspending import
  (func (export "direct") (type $susp_t)
    (call $suspend (local.get 0) (local.get 1)))

  ;; same, via call_indirect (Emscripten calls through function pointers)
  (func (export "indirect") (type $susp_t)
    (call_indirect (type $susp_t) (local.get 0) (local.get 1) (i32.const 0)))

  ;; suspend n times in a loop; the linear memory counter checks state survives
  (func (export "loop") (param $s externref) (param $p externref) (param $n i32) (result i32)
    (local $i i32)
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (drop (call $suspend (local.get $s) (local.get $p)))
        (i32.store (i32.const 0) (i32.add (i32.load (i32.const 0)) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (local.get $i))

  ;; recurse d frames deep, then suspend
  (func $deep (export "deep") (param $s externref) (param $p externref) (param $d i32) (result externref)
    (if (result externref) (i32.eqz (local.get $d))
      (then (call $suspend (local.get $s) (local.get $p)))
      (else (call $deep (local.get $s) (local.get $p) (i32.sub (local.get $d) (i32.const 1))))))

  ;; JS calls back into wasm and returns; then suspend
  (func (export "after_reenter") (type $susp_t)
    (drop (call $reenter (local.get 1)))
    (call $suspend (local.get 0) (local.get 1)))

  (func (export "leaf") (param externref) (result externref) (local.get 0))

  ;; suspend with a JS frame between promising and suspending: spec says the
  ;; suspending import throws a SuspendError
  (func (export "js_frame_between") (type $susp_t)
    (call $call_inner_suspend (local.get 0) (local.get 1)))

  (func (export "inner_suspend") (type $susp_t)
    (call $suspend (local.get 0) (local.get 1)))
)
