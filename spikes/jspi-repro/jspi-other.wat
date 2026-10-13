;; A second instance whose exported function suspends.
(module
  (type $susp_t (func (param externref externref) (result externref)))
  (import "env" "suspend" (func $suspend (type $susp_t)))
  (func (export "thunk") (type $susp_t)
    (call $suspend (local.get 0) (local.get 1)))
)
