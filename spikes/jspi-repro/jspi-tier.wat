;; Hypothesis: optimized-tier or OSR-entered wasm frames between promising and
;; suspending are treated as non-suspendable (like CPython's hot eval loop).
(module
  (type $susp_t (func (param externref externref) (result externref)))
  (import "env" "suspend" (func $suspend (type $susp_t)))
  (global $sink (mut i32) (i32.const 0))

  ;; suspends only when $go != 0
  (func $maybe (export "maybe") (param $s externref) (param $p externref) (param $go i32) (result externref)
    (if (result externref) (local.get $go)
      (then (call $suspend (local.get $s) (local.get $p)))
      (else
        (global.set $sink (i32.add (global.get $sink) (i32.const 1)))
        (ref.null extern))))

  ;; caller with a hot loop (likely OSR'd) that finally calls a suspending callee
  (func (export "hot_caller") (param $s externref) (param $p externref) (param $n i32) (result externref)
    (local $i i32)
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (drop (call $maybe (local.get $s) (local.get $p) (i32.const 0)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (call $maybe (local.get $s) (local.get $p) (i32.const 1)))

  ;; hot loop in the suspending function itself
  (func (export "hot_loop_self") (param $s externref) (param $p externref) (param $n i32) (result externref)
    (local $i i32)
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (global.set $sink (i32.add (global.get $sink) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (call $suspend (local.get $s) (local.get $p)))

  ;; non-looping caller (gets tiered up by being called many times from JS)
  (func (export "plain_caller") (param $s externref) (param $p externref) (param $go i32) (result externref)
    (call $maybe (local.get $s) (local.get $p) (local.get $go)))
)
