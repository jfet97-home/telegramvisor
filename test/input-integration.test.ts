import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { inputDefinitionHash, normalizeInputRequest, renderInputBatch } from "../src/input-domain.js";
import { makeNativeInputIntegration, normalizeNativeInput } from "../src/input-integration.js";
import type { InputT3Request } from "../src/input-t3.js";

const request: InputT3Request = {
  environmentId: "environment", threadId: "thread", requestId: "request", nodeId: "node",
  providerTurnId: null, nativeRequestRef: null, status: "pending", responseCapability: { type: "message" },
  terminal: false, canRespond: true, createdAt: "2026-10-08T00:00:00Z", resolvedAt: null,
  revisionHash: "native-revision",
  owner: { threadId: "thread", runId: "run", nodeId: "node", providerInstanceId: "codex", providerThreadId: null, providerTurnId: null },
  native: {
    request: { id: "request", nodeId: "node", providerTurnId: null, kind: "user_input", status: "pending", createdAt: "2026-10-08T00:00:00Z" },
    turnItem: {
      id: "item",
      threadId: "thread",
      runId: "run",
      nodeId: "node",
      type: "user_input_request",
      requestId: "request",
      questions: [],
    },
  },
  questions: [{ id: "q", header: "Target", question: "Choose the target", multiSelect: true,
    allowCustomAnswer: true, required: false, native: {},
    options: [{ label: "Production", value: "prod", description: "Applies to customer traffic" }] }],
};

test("native mapping preserves option semantics and custom answers while matching native completion requirements", () => {
  const normalized = normalizeInputRequest(normalizeNativeInput(request, "Operations"));
  assert.equal(normalized.questions[0]?.required, true);
  assert.equal(normalized.questions[0]?.allowCustomAnswer, true);
  assert.equal(normalized.questions[0]?.kind, "multi_choice");
  assert.deepEqual(normalized.questions[0]?.choices, [{ value: "prod", label: "Production\nApplies to customer traffic" }]);
  assert.equal(normalized.questions[0]?.prompt, "Target\nChoose the target");
  assert.equal(normalized.nativeT3Anchor?.itemId, "item");
});

test("chat renames change display context without replacing the questionnaire identity", () => {
  const first = normalizeInputRequest(normalizeNativeInput(request, "Operations"));
  const renamed = normalizeInputRequest(normalizeNativeInput(request, "Infrastructure"));
  assert.notEqual(first.displayTitle, renamed.displayTitle);
  assert.equal(first.revisionHash, renamed.revisionHash);
  assert.equal(inputDefinitionHash(first), inputDefinitionHash(renamed));
});

test("chat titles cannot forge completion headers and stay within a scalar-safe bound", () => {
  const forged = normalizeInputRequest(normalizeNativeInput(
    request,
    "Planning\r\nProject: attacker\nThread: forged\n\n",
  ));
  assert.equal(forged.displayTitle, "Planning Project: attacker Thread: forged");
  const cardText = renderInputBatch({ request: forged, answers: {} }).map((message) => message.text).join("\n");
  assert.ok(cardText.startsWith("Chat: Planning Project: attacker Thread: forged\n"));
  assert.ok(!cardText.includes("\nThread: forged\n\n"));
  assert.doesNotMatch(forged.displayTitle ?? "", /[\p{Cc}\uD800-\uDFFF]/u);

  const long = normalizeInputRequest(normalizeNativeInput(request, "😀".repeat(300))).displayTitle ?? "";
  assert.equal(long.length, 512);
  assert.equal([...long].length, 256);
});

test("managed thread filtering receives and preserves the native root thread id", async () => {
  const rootThreadId = "supervisor-root:root-id";
  const http = createServer((request, response) => {
    if (request.url === "/.well-known/t3/environment") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        environmentId: "environment-1",
        orchestrationProtocolVersion: 2,
        serverVersion: "nightly-test",
      }));
      return;
    }
    if (request.url === "/api/orchestration/shell") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 2,
        snapshotSequence: 1,
        projects: [],
        threads: [{
          id: "helper-thread",
          title: "Managed helper",
          projectId: "project-1",
          lineage: {
            parentThreadId: "supervisor-root:root-id",
            relationshipToParent: "subagent",
            rootThreadId,
          },
          pendingRuntimeRequest: null,
        }],
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");

  try {
    let callbackRoot: string | undefined;
    const integration = makeNativeInputIntegration({
      baseUrl: `http://127.0.0.1:${address.port}`,
      readToken: "input-read-token",
      responseToken: "input-response-token",
      isManagedThread: (thread) => {
        callbackRoot = thread.lineage.rootThreadId;
        return thread.lineage.rootThreadId === rootThreadId;
      },
    });
    const threads = await integration.listThreads();
    assert.equal(callbackRoot, rootThreadId);
    assert.deepEqual(threads, [{
      id: "helper-thread",
      rootThreadId,
      active: false,
      archived: false,
      deleted: false,
      delegated: true,
      relationshipToParent: "subagent",
      kind: "main",
    }]);
    await assert.rejects(
      integration.respond("helper-thread", "request-1", { answer: "value" }),
      /Supervisor input is not forwarded or answered\./u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      http.close((error) => error ? reject(error) : resolve());
    });
  }
});
