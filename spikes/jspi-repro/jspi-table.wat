;; Hypothesis: WebKit treats some wasm-to-wasm calls as JS frames. Emscripten
;; MAIN_MODULE builds (Pyodide) fill the function table from JS at runtime and
;; link across instances.
(module
  (type $susp_t (func (param externref externref) (result externref)))
  (import "env" "suspend" (func $suspend (type $susp_t)))
  (import "env" "itable" (table $it 4 funcref))
  (import "env" "other_thunk" (func $other_thunk (type $susp_t)))
  (table $tbl (export "tbl") 4 funcref)
  (elem (table $tbl) (i32.const 1) func $thunk)

  (func $thunk (export "thunk") (type $susp_t)
    (call $suspend (local.get 0) (local.get 1)))

  ;; own table, entry placed by an elem segment (baseline)
  (func (export "own_table_elem") (type $susp_t)
    (call_indirect $tbl (type $susp_t) (local.get 0) (local.get 1) (i32.const 1)))
  ;; own table, entry placed by JS: tbl.set(0, exports.thunk)
  (func (export "own_table_js_set") (type $susp_t)
    (call_indirect $tbl (type $susp_t) (local.get 0) (local.get 1) (i32.const 0)))
  ;; imported table, entry placed by JS
  (func (export "imported_table_js_set") (type $susp_t)
    (call_indirect $it (type $susp_t) (local.get 0) (local.get 1) (i32.const 0)))
  ;; imported table, entry is a function of ANOTHER instance
  (func (export "imported_table_other_instance") (type $susp_t)
    (call_indirect $it (type $susp_t) (local.get 0) (local.get 1) (i32.const 1)))
  ;; direct call of an imported function that is another instance's export
  (func (export "import_other_instance") (type $susp_t)
    (call $other_thunk (local.get 0) (local.get 1)))
)
