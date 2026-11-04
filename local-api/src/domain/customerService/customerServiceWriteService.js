const CUSTOMER_SERVICE_SEND_ACTION = "customerService.chat.sendMessage";
const CUSTOMER_SERVICE_SEND_ENDPOINT = "chat.sendMessage";
const CUSTOMER_SERVICE_SEND_FILE_ACTION = "customerService.chat.sendFile";
const CUSTOMER_SERVICE_SEND_FILE_ENDPOINT = "chat.sendFile";
const CUSTOMER_SERVICE_START_CHAT_ACTION = "customerService.chat.start";
const CUSTOMER_SERVICE_START_CHAT_ENDPOINT = "chat.start";
const CUSTOMER_SERVICE_MARK_ALL_READ_ACTION =
  "customerService.chat.markAllRead";
const CUSTOMER_SERVICE_MARK_READ_ENDPOINT = "chat.read";
// Keep the preview payload below the guarded route's 64 KiB request limit.
const CUSTOMER_SERVICE_MAX_MARK_READ_CHATS = 200;

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function extractSchedulerData(payload = {}) {
  if (payload?.data !== undefined) return payload.data;
  for (const key of ["payload_json", "data_json"]) {
    const raw = payload?.cache?.[key];
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function getSentMessageId(writeResult = {}) {
  return normalizeText(
    writeResult?.data?.result?.message_id ??
      writeResult?.data?.result?.messageId ??
      writeResult?.data?.message_id ??
      writeResult?.data?.messageId,
  );
}

function getHistoryMessageText(message = {}) {
  const data = Array.isArray(message.data) ? message.data : [message.data];
  return data.map(normalizeText).filter(Boolean).join("\n").trim();
}

function isSellerMessage(message = {}) {
  return ["seller", "support"].includes(
    normalizeText(message?.user?.type).toLowerCase(),
  );
}

function findReadBackMessage(
  messages = [],
  { messageId = "", text = "" } = {},
) {
  return messages.find((message) => {
    if (messageId && normalizeText(message.message_id) === messageId)
      return true;
    return isSellerMessage(message) && getHistoryMessageText(message) === text;
  });
}

function getHistoryAttachmentNames(message = {}) {
  const rows = [
    ...(Array.isArray(message?.data) ? message.data : [message?.data]),
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
  ];
  const names = [];
  for (const item of rows) {
    if (typeof item === "string" || typeof item === "number") {
      const text = String(item);
      for (const match of text.matchAll(
        /\[([^\]\r\n]+)\]\(((?:https?:\/\/)[^\s)]+)\)/giu,
      )) {
        const label = normalizeText(match[1]).replace(
          /\s+\(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\)$/iu,
          "",
        );
        if (label) names.push(label);
        try {
          const pathName = new URL(match[2]).pathname;
          const urlName = normalizeText(
            decodeURIComponent(
              pathName.split("/").filter(Boolean).at(-1) || "",
            ),
          );
          if (urlName) names.push(urlName);
        } catch {
          // The visible Markdown label remains usable when an URL cannot be parsed.
        }
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const name = normalizeText(item.name ?? item.file_name ?? item.fileName);
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function getHistoryMessageId(message = {}) {
  return normalizeText(
    message?.message_id ?? message?.messageId ?? message?.id,
  );
}

function hasHistoryAttachment(message = {}) {
  if (message?.is_image === true || message?.isImage === true) return true;
  if (getHistoryAttachmentNames(message).length) return true;
  const rows = [
    ...(Array.isArray(message?.data) ? message.data : [message?.data]),
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
  ];
  return rows.some((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return /!?\[[^\]\r\n]*\]\((?:https?:\/\/)[^\s)]+\)/iu.test(String(item));
    }
    if (!item || typeof item !== "object") return false;
    return Boolean(
      normalizeText(
        item.url ??
          item.src ??
          item.image_url ??
          item.imageUrl ??
          item.file_url ??
          item.fileUrl,
      ),
    );
  });
}

function findReadBackFile(
  messages = [],
  fileName = "",
  {
    messageId = "",
    baselineMessageIds = new Set(),
    isImage = false,
    stagedAt = "",
  } = {},
) {
  const normalizedMessageId = normalizeText(messageId);
  if (normalizedMessageId) {
    const exactMessage = messages.find(
      (message) =>
        isSellerMessage(message) &&
        getHistoryMessageId(message) === normalizedMessageId,
    );
    if (exactMessage) return exactMessage;
  }
  const namedMessage = messages.find(
    (message) =>
      isSellerMessage(message) &&
      getHistoryAttachmentNames(message).includes(fileName),
  );
  if (namedMessage) return namedMessage;

  const baselineIds =
    baselineMessageIds instanceof Set
      ? baselineMessageIds
      : new Set(baselineMessageIds || []);
  const stagedAtMs = Date.parse(stagedAt);
  return messages.find((message) => {
    if (!isSellerMessage(message) || !hasHistoryAttachment(message))
      return false;
    if (isImage && message?.is_image !== true && message?.isImage !== true)
      return false;
    const currentId = getHistoryMessageId(message);
    if (currentId && baselineIds.has(currentId)) return false;
    if (!baselineIds.size && Number.isFinite(stagedAtMs)) {
      const createdAtMs = Date.parse(message?.created_at ?? message?.createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs < stagedAtMs - 5000)
        return false;
    }
    return true;
  });
}

function getStartedChatId(writeResult = {}) {
  return normalizeText(
    writeResult?.data?.result?.chat_id ??
      writeResult?.data?.result?.chatId ??
      writeResult?.data?.chat_id ??
      writeResult?.data?.chatId,
  );
}

function normalizeUnreadCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function readUnreadCountField(
  value,
  keys = ["unread_count", "unreadCount", "unread"],
) {
  if (!value || typeof value !== "object") return { known: false, count: 0 };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return { known: true, count: normalizeUnreadCount(value[key]) };
    }
  }
  return { known: false, count: 0 };
}

function getWriteUnreadReadback(writeResult = {}) {
  for (const source of [
    writeResult?.data?.result,
    writeResult?.data,
    writeResult,
  ]) {
    const value = readUnreadCountField(source);
    if (value.known) return value;
  }
  return { known: false, count: 0 };
}

function normalizeMarkReadTargets(payload = {}) {
  const rawChats = Array.isArray(payload?.chats) ? payload.chats : [];
  const byChatId = new Map();
  const invalid = [];

  rawChats.forEach((rawChat, index) => {
    const chatId = normalizeText(
      rawChat?.chat_id ?? rawChat?.chatId ?? rawChat?.id,
    );
    const firstUnreadMessageId = normalizeText(
      rawChat?.first_unread_message_id ?? rawChat?.firstUnreadMessageId,
    );
    const lastMessageId = normalizeText(
      rawChat?.last_message_id ?? rawChat?.lastMessageId,
    );
    // Ozon accepts a message id as a long integer. Keep it as a string so ids
    // larger than JavaScript's safe integer range are not rounded.
    const fromMessageId =
      normalizeText(rawChat?.from_message_id ?? rawChat?.fromMessageId) ||
      lastMessageId ||
      firstUnreadMessageId;
    const unreadCount = normalizeUnreadCount(
      rawChat?.unread_count ?? rawChat?.unreadCount ?? rawChat?.unread,
    );

    if (!chatId || !fromMessageId) {
      invalid.push({
        index,
        chatId: chatId || null,
        reason: !chatId
          ? "chat_id 缺失"
          : "first_unread_message_id 和 last_message_id 均缺失",
      });
      return;
    }

    const target = {
      chat_id: chatId,
      from_message_id: fromMessageId,
      first_unread_message_id: firstUnreadMessageId || null,
      last_message_id: lastMessageId || null,
      unread_count: unreadCount,
    };
    const previous = byChatId.get(chatId);
    byChatId.set(
      chatId,
      previous
        ? {
            ...previous,
            // The client freezes the newest message the user actually saw.
            // Keep that exact read-through boundary; first_unread_message_id
            // would only clear the oldest unread message.
            from_message_id: target.from_message_id || previous.from_message_id,
            first_unread_message_id:
              previous.first_unread_message_id ||
              target.first_unread_message_id,
            last_message_id: target.last_message_id || previous.last_message_id,
            unread_count: Math.max(previous.unread_count, target.unread_count),
          }
        : target,
    );
  });

  const allTargets = [...byChatId.values()];
  return {
    targets: allTargets.slice(0, CUSTOMER_SERVICE_MAX_MARK_READ_CHATS),
    invalid,
    truncated: allTargets.length > CUSTOMER_SERVICE_MAX_MARK_READ_CHATS,
  };
}

export function createCustomerServiceWriteService({
  ozonScheduler,
  outboundFileStore,
} = {}) {
  const completedMarkReadPreviews = new Map();

  async function executeMarkAllRead({
    preview,
    input,
    shopId,
    endpointKey,
    action,
  } = {}) {
    const previewShopId = normalizeText(
      preview?.shopId || preview?.diff?.shopId,
    );
    const previewAction = normalizeText(
      preview?.action || preview?.diff?.action,
    );
    const previewEndpointKey = normalizeText(
      preview?.endpointKey || preview?.diff?.endpointKey,
    );
    if (
      (previewAction &&
        previewAction !== CUSTOMER_SERVICE_MARK_ALL_READ_ACTION) ||
      (previewEndpointKey &&
        previewEndpointKey !== CUSTOMER_SERVICE_MARK_READ_ENDPOINT)
    ) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: "CUSTOMER_SERVICE_MARK_READ_PREVIEW_MISMATCH",
          message: "标记已读预览动作已变化，请重新创建预览。",
        },
      };
    }
    if (previewShopId && shopId && previewShopId !== shopId) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: "CUSTOMER_SERVICE_MARK_READ_SCOPE_MISMATCH",
          message: "店铺或账号已切换，请重新创建“全部已读”预览。",
        },
      };
    }

    const replayKey = `${shopId}:${preview?.previewId || ""}`;
    if (preview?.previewId && completedMarkReadPreviews.has(replayKey)) {
      return {
        ...completedMarkReadPreviews.get(replayKey),
        replayed: true,
      };
    }

    const previewPayload = preview?.payload ?? preview?.diff?.after ?? {};
    const sourcePayload =
      previewPayload && typeof previewPayload === "object"
        ? previewPayload
        : (input?.payload ?? {});
    const normalized = normalizeMarkReadTargets(sourcePayload);
    if (
      normalized.invalid.length ||
      normalized.truncated ||
      !normalized.targets.length
    ) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: normalized.truncated
            ? "CUSTOMER_SERVICE_MARK_READ_TOO_MANY_CHATS"
            : normalized.targets.length
              ? "CUSTOMER_SERVICE_MARK_READ_PAYLOAD_INVALID"
              : "CUSTOMER_SERVICE_MARK_READ_TARGETS_EMPTY",
          message: normalized.truncated
            ? `一次最多标记 ${CUSTOMER_SERVICE_MAX_MARK_READ_CHATS} 个会话，请分批重试。`
            : normalized.targets.length
              ? `有 ${normalized.invalid.length} 个会话缺少 chat_id 或消息 ID，未执行写入。`
              : "当前没有可标记已读的会话。",
        },
        invalidTargets: normalized.invalid,
      };
    }

    // A confirm request must execute the exact target set recorded at preview
    // time. This prevents a stale dialog from silently writing another chat.
    if (input?.payload !== undefined) {
      const confirmedTargets = normalizeMarkReadTargets(input.payload).targets;
      const targetSignature = (targets) =>
        JSON.stringify(
          targets.map((target) => ({
            chat_id: target.chat_id,
            from_message_id: target.from_message_id,
            first_unread_message_id: target.first_unread_message_id,
            last_message_id: target.last_message_id,
            unread_count: target.unread_count,
          })),
        );
      if (
        targetSignature(normalized.targets) !==
        targetSignature(confirmedTargets)
      ) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_MARK_READ_PREVIEW_MISMATCH",
            message: "标记已读目标已变化，请重新创建预览。",
          },
        };
      }
    }

    const realWrite = input?.realWrite === true && input?.dryRun === false;
    const baseIdempotencyKey =
      normalizeText(input?.idempotencyKey || preview?.idempotencyKey) ||
      `customer-service-mark-all-read:${shopId}:${preview?.previewId || Date.now()}`;
    const writeResults = [];
    const successfulTargets = [];
    const failures = [];

    // Keep this sequential. The endpoint registry's customerService.write
    // bucket deliberately limits writes and Ozon treats read markers as an
    // account-scoped mutation.
    for (const target of normalized.targets) {
      let writeResult;
      try {
        writeResult = await ozonScheduler.executeWrite({
          shopId,
          domain: "customerService",
          endpointKey,
          action,
          priority: "WRITE",
          params: {
            chat_id: target.chat_id,
            from_message_id: target.from_message_id,
          },
          idempotencyKey: `${baseIdempotencyKey}:${target.chat_id}:${target.from_message_id}`,
          requestedBy:
            input?.requestedBy ||
            preview?.requestedBy ||
            "customer-service-mark-all-read",
          previewId: preview?.previewId || input?.previewId,
          realWrite,
          dryRun: !realWrite,
          waitForResult: true,
        });
      } catch (error) {
        failures.push({
          chatId: target.chat_id,
          unreadCount: target.unread_count,
          error: {
            code: error?.code || "CUSTOMER_SERVICE_MARK_READ_WRITE_FAILED",
            message:
              error instanceof Error
                ? error.message
                : String(error || "标记已读提交失败"),
          },
        });
        continue;
      }

      const writeUnreadReadback = getWriteUnreadReadback(writeResult);
      writeResults.push({
        chatId: target.chat_id,
        ok: writeResult?.ok === true,
        dryRun: writeResult?.dryRun === true,
        jobId: writeResult?.jobId || null,
        unreadCount: writeUnreadReadback.known
          ? writeUnreadReadback.count
          : null,
      });
      if (writeResult?.accepted === true || writeResult?.pending === true) {
        failures.push({
          chatId: target.chat_id,
          unreadCount: target.unread_count,
          error: {
            code: "CUSTOMER_SERVICE_MARK_READ_WRITE_PENDING",
            message: "写入已排队，尚未拿到 Ozon 提交结果。",
          },
        });
      } else if (!writeResult?.ok) {
        failures.push({
          chatId: target.chat_id,
          unreadCount: target.unread_count,
          error: writeResult?.error || {
            code: "CUSTOMER_SERVICE_MARK_READ_WRITE_FAILED",
            message: "Ozon 标记已读提交失败。",
          },
        });
      } else {
        successfulTargets.push({
          ...target,
          writeUnreadKnown: writeUnreadReadback.known,
          writeUnreadCount: writeUnreadReadback.count,
        });
      }
    }

    if (!realWrite) {
      return {
        ok: failures.length === 0,
        confirmed: true,
        writeConnected: true,
        writeStatus: failures.length ? "write_failed" : "dry_run_recorded",
        endpointKey,
        action,
        schedulerResult: { writes: writeResults, failures },
        failures,
        readBack: { status: "not_required", rows: 0, verified: 0, targets: [] },
        message: failures.length
          ? "部分 dry-run 记录失败，未写入 Ozon。"
          : "已生成 dry-run 记录，未写入 Ozon。",
      };
    }

    // /v2/chat/read itself returns unread_count. That response is the exact
    // Ozon confirmation for the submitted chat and message boundary; polling
    // the paginated account-wide chat.list is both slower and less precise.
    const readBackTargets = successfulTargets.map((target) => {
      const verified = target.writeUnreadKnown && target.writeUnreadCount === 0;
      return {
        chatId: target.chat_id,
        unreadCount: target.writeUnreadKnown
          ? target.writeUnreadCount
          : target.unread_count,
        writeUnreadCount: target.writeUnreadKnown
          ? target.writeUnreadCount
          : null,
        verified,
        reason: target.writeUnreadKnown
          ? target.writeUnreadCount === 0
            ? ""
            : `Ozon 返回仍有 ${target.writeUnreadCount} 条未读消息`
          : "Ozon chat.read 未返回 unread_count",
      };
    });
    const readBack = {
      status:
        readBackTargets.length > 0 &&
        readBackTargets.every((target) => target.verified)
          ? "success"
          : "mismatch",
      rows: 0,
      verified: readBackTargets.filter((target) => target.verified).length,
      attempts: successfulTargets.length ? 1 : 0,
      source: "chat.read",
      targets: readBackTargets,
      error: null,
    };

    const readBackFailures = readBack.targets
      .filter((item) => !item.verified)
      .map((item) => ({
        chatId: item.chatId,
        unreadCount: item.unreadCount,
        error: {
          code: "CUSTOMER_SERVICE_MARK_READ_READBACK_MISMATCH",
          message: item.reason || "Ozon 尚未回读为已读。",
        },
      }));
    failures.push(...readBackFailures);
    const completed =
      normalized.targets.length > 0 &&
      failures.length === 0 &&
      readBack.status === "success" &&
      readBack.verified === successfulTargets.length;

    const result = {
      ok: completed,
      confirmed: true,
      writeConnected: true,
      writeStatus: completed
        ? "readback_confirmed"
        : failures.length
          ? "partial_failure"
          : "submitted_waiting_readback",
      endpointKey,
      action,
      schedulerResult: { writes: writeResults },
      failures,
      readBack,
      message: completed
        ? `Ozon 已回读确认 ${successfulTargets.length} 个会话已读。`
        : failures.length
          ? `已处理 ${successfulTargets.length} 个会话，${failures.length} 个会话需要重试；未显示全部完成。`
          : "标记已读已提交，尚未从 Ozon 回读确认，当前仅显示处理中。",
      error: completed
        ? null
        : {
            code: failures.length
              ? "CUSTOMER_SERVICE_MARK_READ_PARTIAL"
              : "CUSTOMER_SERVICE_MARK_READ_READBACK_PENDING",
            message: failures.length
              ? "部分会话未能从 Ozon 回读为已读。"
              : "Ozon 尚未回读确认全部会话已读。",
          },
    };
    if (completed && preview?.previewId) {
      completedMarkReadPreviews.set(replayKey, result);
      if (completedMarkReadPreviews.size > 1000) {
        completedMarkReadPreviews.delete(
          completedMarkReadPreviews.keys().next().value,
        );
      }
    }
    return result;
  }

  async function executeConfirmedWrite({ preview, input = {} } = {}) {
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: "CUSTOMER_SERVICE_WRITE_EXECUTOR_NOT_CONNECTED",
          message: "客服写入执行器尚未连接，本次不会写入 Ozon。",
        },
      };
    }

    const action = normalizeText(
      input.action || preview?.action || preview?.diff?.action,
    );
    const endpointKey = normalizeText(
      input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey,
    );
    if (action === CUSTOMER_SERVICE_MARK_ALL_READ_ACTION) {
      if (endpointKey !== CUSTOMER_SERVICE_MARK_READ_ENDPOINT) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH",
            message: `客服标记已读只能走 ${CUSTOMER_SERVICE_MARK_READ_ENDPOINT}。`,
          },
        };
      }
      const shopId = normalizeText(
        input.shopId ||
          input.shop_id ||
          preview?.shopId ||
          preview?.diff?.shopId,
      );
      if (!shopId) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_WRITE_SHOP_ID_REQUIRED",
            message: "客服标记已读必须包含 shopId。",
          },
        };
      }
      return executeMarkAllRead({
        preview,
        input,
        shopId,
        endpointKey,
        action,
      });
    }
    if (action === CUSTOMER_SERVICE_SEND_FILE_ACTION) {
      if (endpointKey !== CUSTOMER_SERVICE_SEND_FILE_ENDPOINT) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH",
            message: `客服附件只能走 ${CUSTOMER_SERVICE_SEND_FILE_ENDPOINT}。`,
          },
        };
      }
      const shopId = normalizeText(
        input.shopId ||
          input.shop_id ||
          preview?.shopId ||
          preview?.diff?.shopId,
      );
      const sourcePayload =
        input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
      const chatId = normalizeText(
        sourcePayload.chat_id ?? sourcePayload.chatId,
      );
      const fileToken = normalizeText(
        sourcePayload.file_token ?? sourcePayload.fileToken,
      );
      const previewPayload = preview?.payload ?? preview?.diff?.after ?? {};
      if (
        !shopId ||
        !chatId ||
        !fileToken ||
        normalizeText(previewPayload.file_token ?? previewPayload.fileToken) !==
          fileToken ||
        normalizeText(previewPayload.chat_id ?? previewPayload.chatId) !==
          chatId
      ) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_FILE_PREVIEW_MISMATCH",
            message: "附件、店铺或会话已变化，请重新创建发送预览。",
          },
        };
      }
      let stagedFile;
      try {
        stagedFile = outboundFileStore?.resolve?.({
          token: fileToken,
          shopId,
          chatId,
        });
      } catch (error) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: error?.code || "CUSTOMER_SERVICE_FILE_STAGE_MISSING",
            message: error?.message || "附件暂存已失效。",
          },
        };
      }
      if (!stagedFile) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_FILE_STAGE_MISSING",
            message: "附件暂存已失效，请重新选择文件。",
          },
        };
      }
      const realWrite = input.realWrite === true && input.dryRun === false;
      const baselineMessageIds = new Set();
      if (realWrite && ozonScheduler?.executeReadOnly) {
        try {
          const baselinePayload = await ozonScheduler.executeReadOnly({
            shopId,
            domain: "customerService",
            endpointKey: "chat.history",
            action: "customer-service-file-baseline",
            priority: "P0",
            params: { chat_id: chatId, limit: 30, direction: "Backward" },
            cacheKey: `customerService:${shopId}:chat.history:${chatId}`,
            idempotencyKey: `customer-service-file-baseline:${shopId}:${chatId}:${stagedFile.sha256}`,
            requestedBy: "customer-service-file-readback",
            forceRefresh: true,
            allowStale: false,
          });
          const baselineHistory = extractSchedulerData(baselinePayload);
          for (const message of Array.isArray(baselineHistory?.messages)
            ? baselineHistory.messages
            : []) {
            const messageId = getHistoryMessageId(message);
            if (messageId) baselineMessageIds.add(messageId);
          }
        } catch {
          // A missing baseline must not block the guarded write; the post-write
          // readback still uses the returned message id, filename and timestamp.
        }
      }
      const writeResult = await ozonScheduler.executeWrite({
        shopId,
        domain: "customerService",
        endpointKey,
        action,
        priority: "WRITE",
        params: {
          chat_id: chatId,
          name: stagedFile.name,
          base64_content: stagedFile.base64Content,
        },
        idempotencyKey:
          normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
          `customer-service-file:${shopId}:${chatId}:${stagedFile.sha256}`,
        requestedBy:
          input.requestedBy ||
          preview?.requestedBy ||
          "customer-service-file-write-guard",
        previewId: preview?.previewId || input.previewId,
        realWrite,
        dryRun: !realWrite,
        waitForResult: true,
      });
      if (!writeResult?.ok) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: true,
          writeStatus: "write_failed",
          endpointKey,
          action,
          error: writeResult?.error || {
            code: "CUSTOMER_SERVICE_FILE_WRITE_FAILED",
            message: "客服附件提交失败。",
          },
          schedulerResult: writeResult || null,
        };
      }
      if (writeResult.dryRun) {
        return {
          ok: true,
          confirmed: true,
          writeConnected: true,
          writeStatus: "dry_run_recorded",
          endpointKey,
          action,
          schedulerResult: writeResult,
          readBack: { status: "not_required", rows: 0, messageId: null },
          message: "客服附件只记录了 dry-run，未写入 Ozon。",
        };
      }
      let readBackPayload = null;
      let readBackError = "";
      try {
        readBackPayload = await ozonScheduler.executeReadOnly?.({
          shopId,
          domain: "customerService",
          endpointKey: "chat.history",
          action: "customer-service-file-readback",
          priority: "P0",
          params: { chat_id: chatId, limit: 30, direction: "Backward" },
          cacheKey: `customerService:${shopId}:chat.history:${chatId}`,
          idempotencyKey: `customer-service-file-readback:${shopId}:${chatId}:${stagedFile.sha256}`,
          requestedBy: "customer-service-file-readback",
          forceRefresh: true,
          allowStale: false,
        });
      } catch (error) {
        readBackError =
          error instanceof Error
            ? error.message
            : String(error || "附件回读失败");
      }
      const history = extractSchedulerData(readBackPayload);
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const sentMessageId = getSentMessageId(writeResult);
      const readBackMessage = findReadBackFile(messages, stagedFile.name, {
        messageId: sentMessageId,
        baselineMessageIds,
        isImage: normalizeText(stagedFile.mimeType)
          .toLowerCase()
          .startsWith("image/"),
        stagedAt: stagedFile.createdAt,
      });
      const readBackConfirmed = Boolean(readBackMessage);
      if (readBackConfirmed) outboundFileStore?.consume?.(fileToken);
      return {
        ok: true,
        confirmed: true,
        writeConnected: true,
        writeStatus: readBackConfirmed
          ? "readback_confirmed"
          : "submitted_waiting_readback",
        endpointKey,
        action,
        schedulerResult: writeResult,
        readBack: {
          status: readBackConfirmed ? "success" : "pending",
          rows: messages.length,
          messageId:
            normalizeText(readBackMessage?.message_id) || sentMessageId || null,
          error: readBackError || null,
        },
        message: readBackConfirmed
          ? "Ozon 已回读到客服附件，发送完成。"
          : "附件已提交，尚未从 Ozon 回读确认。",
      };
    }
    if (action === CUSTOMER_SERVICE_START_CHAT_ACTION) {
      if (endpointKey !== CUSTOMER_SERVICE_START_CHAT_ENDPOINT) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH",
            message: `新建客服会话只能走 ${CUSTOMER_SERVICE_START_CHAT_ENDPOINT}。`,
          },
        };
      }
      const shopId = normalizeText(
        input.shopId ||
          input.shop_id ||
          preview?.shopId ||
          preview?.diff?.shopId,
      );
      const sourcePayload =
        input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
      const postingNumber = normalizeText(
        sourcePayload.posting_number ?? sourcePayload.postingNumber,
      );
      const previewPayload = preview?.payload ?? preview?.diff?.after ?? {};
      if (
        !shopId ||
        !postingNumber ||
        normalizeText(
          previewPayload.posting_number ?? previewPayload.postingNumber,
        ) !== postingNumber
      ) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: false,
          endpointKey,
          action,
          error: {
            code: "CUSTOMER_SERVICE_START_PREVIEW_MISMATCH",
            message: "订单号或店铺已变化，请重新创建新建会话预览。",
          },
        };
      }
      const realWrite = input.realWrite === true && input.dryRun === false;
      const writeResult = await ozonScheduler.executeWrite({
        shopId,
        domain: "customerService",
        endpointKey,
        action,
        priority: "WRITE",
        params: { posting_number: postingNumber },
        idempotencyKey:
          normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
          `customer-service-start:${shopId}:${postingNumber}`,
        requestedBy:
          input.requestedBy ||
          preview?.requestedBy ||
          "customer-service-start-write-guard",
        previewId: preview?.previewId || input.previewId,
        realWrite,
        dryRun: !realWrite,
        waitForResult: true,
      });
      if (!writeResult?.ok) {
        return {
          ok: false,
          confirmed: true,
          writeConnected: true,
          writeStatus: "write_failed",
          endpointKey,
          action,
          error: writeResult?.error || {
            code: "CUSTOMER_SERVICE_START_WRITE_FAILED",
            message:
              "Ozon 新建客服会话失败；请确认店铺套餐、订单履约方式和可发起时间。",
          },
          schedulerResult: writeResult || null,
        };
      }
      if (writeResult.dryRun) {
        return {
          ok: true,
          confirmed: true,
          writeConnected: true,
          writeStatus: "dry_run_recorded",
          endpointKey,
          action,
          schedulerResult: writeResult,
          readBack: { status: "not_required", chatId: null },
          message: "新建会话只记录了 dry-run，未写入 Ozon。",
        };
      }
      const chatId = getStartedChatId(writeResult);
      let readBackPayload = null;
      let readBackError = "";
      if (chatId) {
        try {
          readBackPayload = await ozonScheduler.executeReadOnly?.({
            shopId,
            domain: "customerService",
            endpointKey: "chat.history",
            action: "customer-service-start-readback",
            priority: "P0",
            params: { chat_id: chatId, limit: 1, direction: "Backward" },
            cacheKey: `customerService:${shopId}:chat.history:${chatId}`,
            idempotencyKey: `customer-service-start-readback:${shopId}:${chatId}`,
            requestedBy: "customer-service-start-readback",
            forceRefresh: true,
            allowStale: false,
          });
        } catch (error) {
          readBackError =
            error instanceof Error
              ? error.message
              : String(error || "新会话回读失败");
        }
      }
      const readBackConfirmed = Boolean(
        chatId && readBackPayload?.ok !== false && readBackPayload,
      );
      return {
        ok: true,
        confirmed: true,
        writeConnected: true,
        writeStatus: readBackConfirmed
          ? "readback_confirmed"
          : "submitted_waiting_readback",
        endpointKey,
        action,
        schedulerResult: writeResult,
        readBack: {
          status: readBackConfirmed ? "success" : "pending",
          chatId: chatId || null,
          error: readBackError || null,
        },
        message: readBackConfirmed
          ? "Ozon 已回读确认新会话。"
          : "Ozon 已受理新建会话，尚未回读确认。",
      };
    }
    if (action !== CUSTOMER_SERVICE_SEND_ACTION) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        error: {
          code: "CUSTOMER_SERVICE_WRITE_ACTION_NOT_REGISTERED",
          message: `客服写入动作尚未登记：${action || "unknown"}`,
        },
      };
    }
    if (endpointKey !== CUSTOMER_SERVICE_SEND_ENDPOINT) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: "CUSTOMER_SERVICE_WRITE_ENDPOINT_MISMATCH",
          message: `客服文字回复只能走 ${CUSTOMER_SERVICE_SEND_ENDPOINT}。`,
        },
      };
    }

    const shopId = normalizeText(
      input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId,
    );
    const sourcePayload =
      input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    const chatId = normalizeText(sourcePayload.chat_id ?? sourcePayload.chatId);
    const text = normalizeText(sourcePayload.text);
    if (!shopId || !chatId || !text) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: false,
        endpointKey,
        action,
        error: {
          code: "CUSTOMER_SERVICE_WRITE_PAYLOAD_REQUIRED",
          message: "客服回复必须包含 shopId、chat_id 和 text。",
        },
      };
    }

    const realWrite = input.realWrite === true && input.dryRun === false;
    const idempotencyKey =
      normalizeText(input.idempotencyKey || preview?.idempotencyKey) ||
      `customer-service-write:${shopId}:${chatId}:${preview?.previewId || Date.now()}`;
    const writeResult = await ozonScheduler.executeWrite({
      shopId,
      domain: "customerService",
      endpointKey,
      action,
      priority: "WRITE",
      params: { chat_id: chatId, text },
      idempotencyKey,
      requestedBy:
        input.requestedBy ||
        preview?.requestedBy ||
        "customer-service-write-guard",
      previewId: preview?.previewId || input.previewId,
      realWrite,
      dryRun: !realWrite,
      waitForResult: true,
    });

    if (!writeResult?.ok) {
      return {
        ok: false,
        confirmed: true,
        writeConnected: true,
        writeStatus: "write_failed",
        endpointKey,
        action,
        error: writeResult?.error || {
          code: "CUSTOMER_SERVICE_WRITE_FAILED",
          message: "客服回复提交失败。",
        },
        schedulerResult: writeResult || null,
      };
    }

    if (writeResult.dryRun) {
      return {
        ok: true,
        confirmed: true,
        writeConnected: true,
        writeStatus: "dry_run_recorded",
        endpointKey,
        action,
        schedulerResult: writeResult,
        readBack: { status: "not_required", rows: 0, messageId: null },
        message: "客服回复只记录了 dry-run，未写入 Ozon。",
      };
    }

    const sentMessageId = getSentMessageId(writeResult);
    let readBackPayload = null;
    let readBackError = "";
    if (ozonScheduler?.executeReadOnly) {
      try {
        readBackPayload = await ozonScheduler.executeReadOnly({
          shopId,
          domain: "customerService",
          endpointKey: "chat.history",
          action: "customer-service-send-readback",
          priority: "P0",
          params: { chat_id: chatId, limit: 30, direction: "Backward" },
          cacheKey: `customerService:${shopId}:chat.history:${chatId}`,
          idempotencyKey: `customer-service-readback:${shopId}:${chatId}:${sentMessageId || preview?.previewId || Date.now()}`,
          requestedBy: "customer-service-write-readback",
          forceRefresh: true,
          allowStale: false,
        });
      } catch (error) {
        readBackError =
          error instanceof Error
            ? error.message
            : String(error || "readback failed");
      }
    }

    const history = extractSchedulerData(readBackPayload);
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const readBackMessage = findReadBackMessage(messages, {
      messageId: sentMessageId,
      text,
    });
    const readBackConfirmed = Boolean(readBackMessage);

    return {
      ok: true,
      confirmed: true,
      writeConnected: true,
      writeStatus: readBackConfirmed
        ? "readback_confirmed"
        : "submitted_waiting_readback",
      endpointKey,
      action,
      schedulerResult: writeResult,
      readBack: {
        status: readBackConfirmed ? "success" : "pending",
        rows: messages.length,
        messageId:
          normalizeText(readBackMessage?.message_id) || sentMessageId || null,
        error: readBackError || null,
      },
      message: readBackConfirmed
        ? "Ozon 已回读到客服回复，发送完成。"
        : "回复已提交 Ozon，尚未回读确认，当前仅显示处理中。",
    };
  }

  return {
    executeConfirmedWrite,
  };
}
