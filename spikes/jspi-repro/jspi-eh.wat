;; JSPI combined with exception handling (exnref / try_table, as used by
;; Emscripten 5): throw and catch after resuming from a suspension.
(module
  (type $susp_t (func (param externref externref) (result externref)))
  (import "env" "suspend" (func $suspend (type $susp_t)))
  (tag $e (param i32))

  (func (export "eh_after_resume") (param externref externref) (result i32)
    (block $h (result i32)
      (try_table (catch $e $h)
        (drop (call $suspend (local.get 0) (local.get 1)))
        (throw $e (i32.const 7)))
      (i32.const -1)))

  ;; the suspending import rejects; the JS exception must propagate as a wasm
  ;; exception (caught via catch_all)
  (func (export "eh_rejected") (param externref externref) (result i32)
    (block $h
      (try_table (catch_all $h)
        (drop (call $suspend (local.get 0) (local.get 1)))
        (return (i32.const -1))))
    (i32.const 1))
)
