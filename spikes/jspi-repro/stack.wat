;; Plain recursion (no JSPI) to measure the native stack available to wasm.
(module
  (func $rec (export "rec") (param $n i32) (result i32)
    (if (result i32) (i32.eqz (local.get $n))
      (then (i32.const 0))
      (else (i32.add (i32.const 1) (call $rec (i32.sub (local.get $n) (i32.const 1)))))))
  ;; a frame with more locals, closer to CPython's big functions
  (func $fat (export "fat") (param $n i32) (result i32)
    (local i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64)
    (if (result i32) (i32.eqz (local.get $n))
      (then (i32.const 0))
      (else (i32.add (i32.const 1) (call $fat (i32.sub (local.get $n) (i32.const 1)))))))
)
