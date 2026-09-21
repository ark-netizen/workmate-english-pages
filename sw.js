// 백엔드가 GitHub Pages(이 서비스워커의 origin)가 아니라 Supabase Edge Function이라, 상대경로("/api/...")로
// fetch하면 안 되고 이 주소로 절대경로를 만들어 호출해야 한다.
const API_BASE_URL = "https://zchagwujhqjfteehexmp.functions.supabase.co";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function conversationIdFromUrl(url) {
  try {
    const pathname = new URL(url, self.location.origin).pathname;
    const match = pathname.match(/^\/(?:messenger|email)\/([^/?#]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "부캐영어", body: event.data.text() };
  }

  const title = payload.title || "부캐영어";
  const targetUrl = payload.url || "/";
  const conversationId = conversationIdFromUrl(targetUrl);
  const isReview = title.includes("복습");
  // 리포트/고함항아리/복습/이미 보낸 답장의 회신 알림에는 "외근 중"이 의미가 없다.
  // 실제 업무 연락(메신저/이메일)에서만 30분 재알림 액션을 노출한다.
  const allowFieldWork =
    !!conversationId &&
    !isReview &&
    title !== "고함항아리" &&
    !title.includes("회신했습니다") &&
    !title.includes("업무일지");

  // 대화/이메일이 아닌 리포트·일반 시스템 알림에 액션 버튼이 붙으면
  // 버튼 문구와 실제 이동 경로가 달라진다. 대화 target일 때만 이동 액션을 보여준다.
  // 복습 알림은 일반 업무 연락과 구분해서 목적이 바로 보이도록 "복습하기"로 표시한다.
  const actions = conversationId
    ? [{ action: "reply", title: isReview ? "복습하기" : "메시지 작성하기" }]
    : [];
  if (allowFieldWork) {
    actions.push({ action: "field-work", title: "외근 중 (30분 후 재알림)" });
  }

  const options = {
    body: payload.body,
    icon: "/brand/logo-mark.png",
    data: { url: targetUrl, conversationId },
    actions,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 듀얼 모니터 시연 녹화용으로 따로 띄운 QA 도구 창(/qa)은 같은 origin의 클라이언트라서
// matchAll에 같이 잡히는데, 여기로 알림을 열면 녹화 화면(메인 창)이 아니라 QA 창에
// 대화가 떠버린다 — 알림 이동 대상에서는 항상 제외한다
function isQaPopup(clientUrl) {
  try {
    return new URL(clientUrl).pathname === "/qa";
  } catch {
    return false;
  }
}

function focusOrOpen(url) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if (client.url.startsWith(self.location.origin) && !isQaPopup(client.url) && "focus" in client) {
        return client.navigate(url).then((focused) => focused && focused.focus());
      }
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(url);
    }
  });
}

// 앱을 열지 않고도 "외근중"을 처리 — 로그인 세션이 없으므로 이 기기의 구독 endpoint로 사용자를 식별.
// 알림 data에 conversationId도 같이 넣어 "그 알림"을 정확히 30분 뒤 다시 보낸다.
// 실패 원인별 안내 문구 — 예전에는 어떤 실패든 "네트워크 문제"라고만 띄워서, 실제로는 이 기기의
// 구독이 만료(404)됐거나 서버가 500을 낸 경우에도 사용자가 네트워크를 의심하며 계속 재시도하게 됐다.
// 원인이 다르면 사용자가 할 수 있는 조치도 다르므로 구분해서 알려준다.
function fieldWorkFailureBody(reason) {
  if (reason === "no-subscription" || reason === 404) {
    return "이 기기의 알림 구독이 만료됐어요. 앱에서 알림을 껐다 다시 켜주세요.";
  }
  if (typeof reason === "number" && reason >= 500) {
    return `서버 오류로 처리가 안 됐어요 (${reason}). 앱에서 다시 시도해주세요.`;
  }
  if (typeof reason === "number") {
    return `처리가 안 됐어요 (${reason}). 앱에서 다시 시도해주세요.`;
  }
  return "네트워크 문제로 처리가 안 됐어요. 앱에서 다시 시도해주세요.";
}

function handleFieldWorkAction(conversationId) {
  return self.registration.pushManager
    .getSubscription()
    .then((subscription) => {
      if (!subscription) return Promise.reject(Object.assign(new Error("구독 정보 없음"), { reason: "no-subscription" }));
      return fetch(`${API_BASE_URL}/api/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint, action: "field-work", conversationId }),
      });
    })
    .then((response) => {
      if (!response.ok) {
        throw Object.assign(new Error(`외근 처리 실패: ${response.status}`), { reason: response.status });
      }
      return response.json().catch(() => ({}));
    })
    .then((result) =>
      self.registration.showNotification("외근 처리됐습니다", {
        body: result?.reminderScheduled
          ? "이 연락을 30분 후 다시 알려드릴게요."
          : "외근 상태를 기록했습니다.",
        icon: "/brand/logo-mark.png",
        tag: "field-work-ack",
      }),
    )
    .catch((err) =>
      self.registration.showNotification("외근 처리 실패", {
        body: fieldWorkFailureBody(err?.reason),
        icon: "/brand/logo-mark.png",
        tag: "field-work-ack",
      }),
    );
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  if (event.action === "field-work") {
    event.waitUntil(handleFieldWorkAction(event.notification.data?.conversationId || conversationIdFromUrl(targetUrl)));
    return;
  }

  event.waitUntil(focusOrOpen(targetUrl));
});
