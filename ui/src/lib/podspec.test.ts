import { describe, expect, it } from "vitest";
import {
  affinityOf,
  envOf,
  expandVars,
  fieldValue,
  handlerText,
  isDefaultToleration,
  isEnvName,
  lifecycleOf,
  nodeTermText,
  parseQuantity,
  podAffinityText,
  probesOf,
  requirementText,
  resourceFieldValue,
  selectorText,
  spreadText,
  tolerationText,
  topologyText,
} from "./podspec";

describe("quantities", () => {
  it("parses the suffixes Kubernetes accepts", () => {
    expect(parseQuantity("250m")).toBeCloseTo(0.25);
    expect(parseQuantity("1.5")).toBe(1.5);
    expect(parseQuantity("512Mi")).toBe(512 * 1024 * 1024);
    expect(parseQuantity("1G")).toBe(1e9);
    expect(parseQuantity("1e3")).toBe(1000);
    expect(parseQuantity(".5")).toBe(0.5);
    expect(parseQuantity(4)).toBe(4);
    expect(parseQuantity("lots")).toBeNaN();
    expect(parseQuantity("1Qi")).toBeNaN();
    expect(parseQuantity(undefined)).toBeNaN();
  });
});

describe("probes and hooks", () => {
  const ports = [{ name: "http", containerPort: 8080 }];

  it("says what each kind of check does, named ports with their number", () => {
    expect(handlerText({ httpGet: { path: "/healthz", port: "http" } }, ports)).toBe("HTTP GET :http (8080)/healthz");
    expect(handlerText({ httpGet: { path: "/", port: 443, scheme: "HTTPS", host: "10.0.0.1", httpHeaders: [{ name: "X", value: "y" }] } })).toBe("HTTPS GET 10.0.0.1:443/ (+1 header)");
    expect(handlerText({ tcpSocket: { port: 5432 } })).toBe("TCP :5432");
    expect(handlerText({ grpc: { port: 9090, service: "health" } })).toBe("gRPC :9090 (health)");
    expect(handlerText({ exec: { command: ["pg_isready", "-U", "app"] } })).toBe("exec: pg_isready -U app");
    expect(handlerText({ sleep: { seconds: 5 } })).toBe("sleep 5s");
    expect(handlerText({ httpGet: { port: "metrics" } }, ports)).toBe("HTTP GET :metrics/");
  });

  it("lists probes startup first, with the API's defaults and how long a slow start may take", () => {
    const c = {
      ports,
      readinessProbe: { httpGet: { path: "/ready", port: "http" }, periodSeconds: 5 },
      livenessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 10, failureThreshold: 1 },
      startupProbe: { exec: { command: ["true"] }, periodSeconds: 2, failureThreshold: 30, successThreshold: 1 },
    };
    const probes = probesOf(c);
    expect(probes.map((p) => p.kind)).toEqual(["startup", "liveness", "readiness"]);
    expect(probes[0].timing).toBe("every 2s · timeout 1s · 30 failures · ≤60s to start");
    expect(probes[1]).toMatchObject({ check: "TCP :8080", timing: "every 10s · timeout 1s · 1 failure · after 10s" });
    expect(probes[2]).toMatchObject({ check: "HTTP GET :http (8080)/ready", detail: "http-get http://:http/ready delay=0s timeout=1s period=5s #success=1 #failure=3" });
    expect(probesOf({})).toEqual([]);
  });

  it("lists lifecycle hooks", () => {
    expect(lifecycleOf({ lifecycle: { preStop: { sleep: { seconds: 5 } }, postStart: { exec: { command: ["sh", "-c", "warm"] } } } })).toEqual(["postStart: exec: sh -c warm", "preStop: sleep 5s"]);
    expect(lifecycleOf({})).toEqual([]);
  });
});

describe("environment", () => {
  it("tells apart where each variable comes from", () => {
    const { vars, from } = envOf({
      env: [
        { name: "A", value: "1" },
        { name: "EMPTY" },
        { name: "C", valueFrom: { configMapKeyRef: { name: "cm", key: "k" } } },
        { name: "S", valueFrom: { secretKeyRef: { name: "sec", key: "pw", optional: true } } },
        { name: "IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
        { name: "CPU", valueFrom: { resourceFieldRef: { resource: "limits.cpu", divisor: "1m" } } },
      ],
      envFrom: [{ configMapRef: { name: "all" } }, { prefix: "X_", secretRef: { name: "creds", optional: true } }, {}],
    });
    expect(vars).toEqual([
      { name: "A", value: "1", source: { kind: "value" } },
      { name: "EMPTY", value: "", source: { kind: "value" } },
      { name: "C", source: { kind: "configMap", name: "cm", key: "k", optional: false } },
      { name: "S", source: { kind: "secret", name: "sec", key: "pw", optional: true } },
      { name: "IP", source: { kind: "field", path: "status.podIP" } },
      { name: "CPU", source: { kind: "resource", resource: "limits.cpu", container: undefined, divisor: "1m" } },
    ]);
    expect(from).toEqual([
      { kind: "configMap", name: "all", prefix: "", optional: false },
      { kind: "secret", name: "creds", prefix: "X_", optional: true },
    ]);
  });

  it("reads what the downward API gives from the pod", () => {
    const pod = {
      metadata: { name: "web-1", namespace: "shop", uid: "u1", labels: { app: "web" }, annotations: { "a/b": "c" } },
      spec: { nodeName: "n1", serviceAccountName: "web" },
      status: { podIP: "10.0.0.5", podIPs: [{ ip: "10.0.0.5" }, { ip: "fd00::5" }], hostIP: "172.16.0.1" },
    };
    expect(fieldValue(pod, "metadata.name")).toBe("web-1");
    expect(fieldValue(pod, "metadata.labels['app']")).toBe("web");
    expect(fieldValue(pod, "metadata.annotations['a/b']")).toBe("c");
    expect(fieldValue(pod, "status.podIPs")).toBe("10.0.0.5,fd00::5");
    expect(fieldValue(pod, "spec.nodeName")).toBe("n1");
    expect(fieldValue(pod, "metadata.labels['missing']")).toBeUndefined();
    expect(fieldValue(pod, "spec.unknown")).toBeUndefined();
  });

  it("divides resources like the kubelet, rounding up", () => {
    const c = { resources: { requests: { cpu: "250m", memory: "300Mi" }, limits: { cpu: "1500m", memory: "1Gi" } } };
    expect(resourceFieldValue(c, "requests.cpu")).toBe("1");
    expect(resourceFieldValue(c, "requests.cpu", "1m")).toBe("250");
    expect(resourceFieldValue(c, "limits.cpu")).toBe("2");
    expect(resourceFieldValue(c, "limits.memory", "1Mi")).toBe("1024");
    expect(resourceFieldValue(c, "requests.memory")).toBe(String(300 * 1024 * 1024));
    expect(resourceFieldValue({}, "limits.cpu")).toBeUndefined();
    expect(resourceFieldValue(c, "limits.cpu", "0")).toBeUndefined();
  });

  it("expands $(VAR) like Kubernetes", () => {
    const vars: Record<string, string> = { HOST: "db", PORT: "5432" };
    const look = (n: string) => vars[n];
    expect(expandVars("postgres://$(HOST):$(PORT)/app", look)).toBe("postgres://db:5432/app");
    expect(expandVars("$(UNKNOWN) stays", look)).toBe("$(UNKNOWN) stays");
    expect(expandVars("$$(HOST) is escaped", look)).toBe("$(HOST) is escaped");
    expect(expandVars("price $5, open $(", look)).toBe("price $5, open $(");
    expect(expandVars("trailing $", look)).toBe("trailing $");
  });

  it("knows which keys make variables", () => {
    expect(isEnvName("LOG_LEVEL")).toBe(true);
    expect(isEnvName("config.yaml")).toBe(true);
    expect(isEnvName("1st")).toBe(false);
    expect(isEnvName("has space")).toBe(false);
  });
});

describe("scheduling", () => {
  it("words selector requirements", () => {
    expect(requirementText({ key: "zone", operator: "In", values: ["z1", "z2"] })).toBe("zone in (z1, z2)");
    expect(requirementText({ key: "arch", operator: "In", values: ["arm64"] })).toBe("arch = arm64");
    expect(requirementText({ key: "pool", operator: "NotIn", values: ["batch"] })).toBe("pool ≠ batch");
    expect(requirementText({ key: "gpu", operator: "Exists" })).toBe("gpu exists");
    expect(requirementText({ key: "spot", operator: "DoesNotExist" })).toBe("no spot");
    expect(requirementText({ key: "cores", operator: "Gt", values: ["8"] })).toBe("cores > 8");
    expect(nodeTermText({ matchExpressions: [{ key: "a", operator: "Exists" }], matchFields: [{ key: "metadata.name", operator: "In", values: ["n1"] }] })).toBe("a exists and metadata.name = n1");
    expect(nodeTermText({})).toBe("any node");
    expect(selectorText({ matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["a", "b"] }] })).toBe("app=web, tier in (a, b)");
    expect(selectorText({})).toBe("every pod");
    expect(topologyText("kubernetes.io/hostname")).toBe("node");
    expect(topologyText("rack")).toBe("rack");
  });

  it("words node and pod (anti-)affinity, required terms as alternatives", () => {
    const a = affinityOf({
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "zone", operator: "In", values: ["z1"] }] }, { matchExpressions: [{ key: "ssd", operator: "Exists" }] }] },
          preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 50, preference: { matchExpressions: [{ key: "spot", operator: "DoesNotExist" }] } }],
        },
        podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: "cache" } }, topologyKey: "topology.kubernetes.io/zone" }] },
        podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { labelSelector: { matchLabels: { app: "web" } }, topologyKey: "kubernetes.io/hostname", namespaces: ["shop"] } }] },
      },
    });
    expect(a.node).toEqual([
      { required: true, text: "zone = z1  or  ssd exists" },
      { required: false, weight: 50, text: "no spot" },
    ]);
    expect(a.pod).toEqual([{ required: true, text: "in a zone with pods app=cache" }]);
    expect(a.antiPod).toEqual([{ required: false, weight: 100, text: "not on a node with pods app=web in shop" }]);
    expect(podAffinityText({ labelSelector: { matchLabels: { app: "x" } }, topologyKey: "rack", namespaceSelector: {} }, false)).toBe("in the same rack with pods app=x in any namespace");
    expect(affinityOf({})).toEqual({ node: [], pod: [], antiPod: [] });
  });

  it("words tolerations and tells the defaults every pod gets apart", () => {
    const def = { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 };
    expect(isDefaultToleration(def)).toBe(true);
    expect(isDefaultToleration({ ...def, tolerationSeconds: 30 })).toBe(false);
    expect(tolerationText(def)).toBe("node.kubernetes.io/not-ready:NoExecute for 300s");
    expect(tolerationText({ key: "dedicated", operator: "Equal", value: "gpu", effect: "NoSchedule" })).toBe("dedicated=gpu:NoSchedule");
    expect(tolerationText({ operator: "Exists" })).toBe("every taint");
    expect(tolerationText({ operator: "Exists", effect: "NoSchedule" })).toBe("every NoSchedule taint");
    expect(tolerationText({ key: "k", operator: "Exists" })).toBe("k (any effect)");
  });

  it("words topology spread constraints", () => {
    expect(spreadText({ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "DoNotSchedule", labelSelector: { matchLabels: { app: "web" } } })).toBe("at most 1 apart across zones, pods app=web");
    expect(spreadText({ maxSkew: 2, topologyKey: "kubernetes.io/hostname", minDomains: 3, labelSelector: { matchLabels: { app: "web" } }, matchLabelKeys: ["pod-template-hash"] })).toBe(
      "at most 2 apart across nodes, pods app=web (at least 3 nodes, same pod-template-hash)",
    );
  });
});
