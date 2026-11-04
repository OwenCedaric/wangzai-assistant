-- 客服投诉取得工单后不再等待或回读客服审核结果。
-- 历史状态统一进入“等待用户主动复查”，工单、证据、SKU、提交结果和
-- 投诉前跟卖基线均保留，供单商品数量复查继续使用。
UPDATE follow_seller_cases
   SET status = 'verification_ready',
       stage = 'awaiting_manual_verification'
 WHERE status IN (
   'awaiting_support_review',
   'awaiting_verification',
   'evidence_required',
   'readback_mismatch'
 );

UPDATE follow_seller_cases
   SET stage = 'awaiting_manual_verification'
 WHERE stage IN (
   'waiting_support_reply',
   'ready_for_follow_check',
   'support_requested_evidence'
 );

PRAGMA user_version = 92;
