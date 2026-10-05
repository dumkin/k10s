//! Interactive terminals: a shell in a running container (`exec`), the container's own console (`attach`), a
//! debug container added to a pod (`kubectl debug`), and a shell on a node through a helper pod
//! (`kubectl node-shell`). Each session is one task: it streams the terminal's output to its sink and takes
//! keystrokes, resizes and acknowledgements from the UI ([`Control`]).
//!
//! Sessions talk to the API server over a websocket opened through the cluster's endpoint, with the
//! credentials in effect when they open (rejected ones are renewed and the opening tried once more). A broken
//! session is not reopened by itself: a shell cannot be resumed — the UI offers to start a new one.
//!
//! Entering a container is a change like any other (a shell can change anything in it): refused in read-only
//! mode — when the session starts and again right before its stream opens — and journalled (`k10s::audit`:
//! where, and how it went; never what was typed). Before the stream opens, the pod is looked at: kube does
//! not pass on why the API server refused to open it, while the container's state says it plainly (not
//! running, crash-looping, no such container…). Containers created for the session are waited for while they
//! start (pulling their image), up to [`WAIT_FOR_RUNNING`].
//!
//! Output is flow-controlled: the UI acknowledges what its terminal has drawn, and reading stops while more
//! than [`HIGH_WATER`] bytes wait unacknowledged — `cat` of a big file slows down instead of flooding the web
//! view; the container then waits on the stream like on a slow terminal.
//!
//! A debug container stays in its pod (Kubernetes cannot remove one). The helper pod of a node shell is
//! deleted when its session ends, however it ends — also when the UI reloads, and also in read-only mode: a
//! privileged pod in the node's namespaces must not outlive what it was made for.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::Api;
use kube::api::{AttachParams, AttachedProcess, TerminalSize};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::cluster::Cluster;
use crate::engine::Inner;
use crate::error::{Error, Result};
use crate::object::ObjectRef;
use crate::ops;
use crate::view::Sink;

/// Output read at once, and the stream buffers on either side.
const CHUNK: usize = 64 * 1024;
/// Output sent but not yet acknowledged by the UI beyond which reading stops until it catches up.
const HIGH_WATER: usize = 1 << 20;
/// Opening the stream (the API server reaching the node's kubelet).
const OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// A container created for the session (debug container, node shell) gets this long to start.
const WAIT_FOR_RUNNING: Duration = Duration::from_secs(300);
/// How often a starting container is looked at.
const POLL: Duration = Duration::from_secs(1);
/// After the output ended, how long the process' exit status is waited for.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// The node shell's helper container (see [`node_shell_pod`]).
pub const NODE_SHELL_CONTAINER: &str = "shell";
/// The helper pod sleeps this long at most, should k10s be gone before it could delete it.
const NODE_SHELL_LIFETIME_SECS: u32 = 86_400;

/// Starts the container's best shell — bash, else ash, else sh — with a terminal type set: many images set
/// none, and `clear`, `top` or vi then refuse to work.
const SHELL: &str = r#"export TERM="${TERM:-xterm-256color}"; for s in bash ash; do command -v "$s" >/dev/null 2>&1 && exec "$s"; done; exec sh"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TermSize {
    fn default() -> Self {
        TermSize { cols: 80, rows: 24 }
    }
}

/// A terminal in a container of a pod: a shell in it, or its own console (`attach`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermSpec {
    pub cluster: String,
    pub namespace: String,
    pub pod: String,
    /// The pod's uid: a pod re-created under the same name since it was picked is not entered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    pub container: String,
    /// Attach to the container's own process (its stdin and terminal) instead of starting a shell in it.
    #[serde(default)]
    pub attach: bool,
    /// The terminal's size when it opens.
    #[serde(default)]
    pub size: TermSize,
}

/// A debug container added to a pod and attached to (`kubectl debug -it --image … --target …`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSpec {
    pub cluster: String,
    pub namespace: String,
    pub pod: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    pub image: String,
    /// The container whose processes the debug container sees (shares its process namespace).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default)]
    pub size: TermSize,
}

/// A shell on a node: in its namespaces, through a privileged helper pod created in `namespace`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeShellSpec {
    pub cluster: String,
    pub node: String,
    pub namespace: String,
    pub image: String,
    #[serde(default)]
    pub size: TermSize,
}

/// What the UI sends a running session.
#[derive(Debug)]
pub(crate) enum Control {
    /// Keystrokes (and pasted text).
    Input(Vec<u8>),
    Resize(TermSize),
    /// The UI's terminal has drawn this many more bytes of output.
    Ack(usize),
}

pub(crate) type Controls = mpsc::UnboundedSender<Control>;

/// What a session is doing, as reported to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    /// Waiting for the cluster's connection, creating what the session needs, opening the stream.
    Connecting,
    /// The container does not run yet (being created, pulling its image): entered once it runs.
    Waiting,
    /// Keystrokes go to the container.
    Open,
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Msg<'a> {
    State {
        state: State,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
        /// What the session entered once known: a node shell's helper pod, a debug container.
        #[serde(skip_serializing_if = "Option::is_none")]
        pod: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        container: Option<&'a str>,
    },
    /// Output, base64 (`d`), and its size in bytes (`n`, what the acknowledgements count).
    Out { d: String, n: usize },
    /// The session is over: the process exited (`code`), or it failed or broke off (`error`, `message`).
    End {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
        error: bool,
    },
}

/// The UI is gone (the sink refused a message): the session stops.
#[derive(Debug)]
struct Closed;

/// A session's messages. State changes only: repeating a state (a container still being created) sends nothing.
struct Out {
    sink: Sink,
    shown: parking_lot::Mutex<Option<(State, Option<String>)>>,
}

impl Out {
    fn new(sink: Sink) -> Self {
        Out { sink, shown: parking_lot::Mutex::new(None) }
    }

    fn send(&self, msg: &Msg) -> Result<(), Closed> {
        let json = serde_json::to_string(msg).unwrap_or_default();
        if (self.sink)(json) { Ok(()) } else { Err(Closed) }
    }

    fn state(&self, state: State, message: Option<&str>) -> Result<(), Closed> {
        {
            let mut shown = self.shown.lock();
            if shown.as_ref().is_some_and(|(s, m)| *s == state && m.as_deref() == message) {
                return Ok(());
            }
            *shown = Some((state, message.map(str::to_string)));
        }
        self.send(&Msg::State { state, message, pod: None, container: None })
    }

    fn entered(&self, state: State, message: Option<&str>, pod: &str, container: &str) -> Result<(), Closed> {
        *self.shown.lock() = Some((state, message.map(str::to_string)));
        self.send(&Msg::State { state, message, pod: Some(pod), container: Some(container) })
    }

    fn output(&self, bytes: &[u8]) -> Result<(), Closed> {
        self.send(&Msg::Out { d: base64::engine::general_purpose::STANDARD.encode(bytes), n: bytes.len() })
    }

    fn end(&self, ending: &Ending) {
        let msg = match ending {
            Ending::Exited(code) => Msg::End { code: *code, message: None, error: false },
            Ending::Failed(message) => Msg::End { code: None, message: Some(message), error: true },
        };
        let _ = self.send(&msg);
    }
}

/// How a session ended.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Ending {
    /// The process exited, with its code when the API server said.
    Exited(Option<i32>),
    /// It could not start, or broke off (the connection, the container).
    Failed(String),
}

impl Ending {
    fn failed(message: impl Into<String>) -> Self {
        Ending::Failed(message.into())
    }
}

/// How a session enters its container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum How {
    /// A shell in it.
    Shell,
    /// Its own process (its stdin and terminal).
    Attach,
    /// A shell in the node's namespaces, from the helper pod's container.
    NodeShell,
}

/// What a session enters.
struct Entry {
    /// The pod (`uid`: the one picked).
    pod: ObjectRef,
    container: String,
    how: How,
    /// The container was created for the session and may not run yet: waited for rather than reported.
    starting: bool,
}

impl Entry {
    fn action(&self) -> &'static str {
        match self.how {
            How::Shell => "exec",
            How::Attach => "attach",
            How::NodeShell => "node-shell exec",
        }
    }
}

fn pod_ref(cluster: &str, namespace: &str, name: &str, uid: Option<String>) -> ObjectRef {
    ObjectRef { cluster: cluster.to_string(), resource: "pods".into(), namespace: Some(namespace.to_string()), name: name.to_string(), uid }
}

/// A terminal in a running container, until its process ends or the session is cancelled.
pub(crate) async fn run(inner: Arc<Inner>, spec: TermSpec, sink: Sink, mut control: mpsc::UnboundedReceiver<Control>) {
    let out = Out::new(sink);
    let entry = Entry {
        pod: pod_ref(&spec.cluster, &spec.namespace, &spec.pod, spec.uid.clone()),
        container: spec.container.clone(),
        how: if spec.attach { How::Attach } else { How::Shell },
        starting: false,
    };
    let ending = match enter(&inner, &entry, spec.size, &out, &mut control).await {
        Ok(ending) => ending,
        Err(Closed) => return,
    };
    out.end(&ending);
}

/// Adds a debug container to the pod and attaches to it once it runs.
pub(crate) async fn run_debug(inner: Arc<Inner>, spec: DebugSpec, sink: Sink, mut control: mpsc::UnboundedReceiver<Control>) {
    let out = Out::new(sink);
    let pod = pod_ref(&spec.cluster, &spec.namespace, &spec.pod, spec.uid.clone());
    if out.state(State::Connecting, Some("adding a debug container")).is_err() {
        return;
    }
    let container = match ops::add_debug_container(&inner, &pod, &spec.image, spec.target.as_deref()).await {
        Ok(name) => name,
        Err(e) => return out.end(&Ending::Failed(e.message())),
    };
    let entry = Entry { pod, container, how: How::Attach, starting: true };
    if out.entered(State::Waiting, Some(&format!("starting {}", spec.image)), &entry.pod.name, &entry.container).is_err() {
        return;
    }
    if let Ok(ending) = enter(&inner, &entry, spec.size, &out, &mut control).await {
        out.end(&ending);
    }
}

/// Creates the node's helper pod, opens a shell in the node's namespaces from it once it runs, and deletes
/// it when the session ends — however it ends: the guard's drop does it, also when the task is cancelled.
pub(crate) async fn run_node_shell(inner: Arc<Inner>, spec: NodeShellSpec, sink: Sink, mut control: mpsc::UnboundedReceiver<Control>) {
    let out = Out::new(sink);
    if out.state(State::Connecting, Some(&format!("creating a helper pod on {}", spec.node))).is_err() {
        return;
    }
    let pod = match ops::create_node_shell_pod(&inner, &spec, node_shell_pod(&spec)).await {
        Ok(pod) => pod,
        Err(e) => return out.end(&Ending::Failed(e.message())),
    };
    let _helper = HelperPod { inner: inner.clone(), pod: pod.clone() };
    let entry = Entry { pod, container: NODE_SHELL_CONTAINER.into(), how: How::NodeShell, starting: true };
    if out.entered(State::Waiting, Some(&format!("starting {}", spec.image)), &entry.pod.name, &entry.container).is_err() {
        return;
    }
    if let Ok(ending) = enter(&inner, &entry, spec.size, &out, &mut control).await {
        out.end(&ending);
    }
}

/// Deletes a node shell's helper pod when dropped (see [`ops::remove_helper_pod`]).
struct HelperPod {
    inner: Arc<Inner>,
    pod: ObjectRef,
}

impl Drop for HelperPod {
    fn drop(&mut self) {
        let (inner, pod) = (self.inner.clone(), self.pod.clone());
        self.inner.rt.spawn(async move { ops::remove_helper_pod(&inner, &pod).await });
    }
}

/// The helper pod of a node shell: on the node (bypassing the scheduler, tolerating every taint), privileged,
/// in the node's PID, network and IPC namespaces, sleeping — a shell enters the node's namespaces from it
/// with `nsenter` (see [`node_shell_command`]). It sleeps a day at most, should k10s be gone before it could
/// delete it.
pub(crate) fn node_shell_pod(spec: &NodeShellSpec) -> Value {
    serde_json::json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "generateName": "k10s-node-shell-",
            "namespace": spec.namespace,
            "labels": { "app.kubernetes.io/managed-by": "k10s", "app.kubernetes.io/name": "node-shell" },
            "annotations": { "k10s.io/node": spec.node },
        },
        "spec": {
            "nodeName": spec.node,
            "hostPID": true,
            "hostNetwork": true,
            "hostIPC": true,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            "automountServiceAccountToken": false,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": NODE_SHELL_CONTAINER,
                "image": spec.image,
                "command": ["sleep", NODE_SHELL_LIFETIME_SECS.to_string()],
                "securityContext": { "privileged": true },
            }],
        },
    })
}

/// The container's shell (`cmd` in Windows pods).
fn shell_command(pod: Option<&Value>) -> Vec<String> {
    if pod.is_some_and(is_windows) {
        return vec!["cmd".into()];
    }
    vec!["sh".into(), "-c".into(), SHELL.into()]
}

/// A shell in the node's mount, UTS, IPC, network and PID namespaces (those of its PID 1).
fn node_shell_command() -> Vec<String> {
    ["nsenter", "--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--", "sh", "-c", SHELL].map(String::from).to_vec()
}

fn is_windows(pod: &Value) -> bool {
    pod.pointer("/spec/os/name").and_then(Value::as_str) == Some("windows")
        || pod.pointer("/spec/nodeSelector/kubernetes.io~1os").and_then(Value::as_str) == Some("windows")
}

/// Opens the session's stream once its container runs, then pumps it until the process ends.
async fn enter(inner: &Arc<Inner>, e: &Entry, mut size: TermSize, out: &Out, control: &mut mpsc::UnboundedReceiver<Control>) -> Result<Ending, Closed> {
    let action = e.action();
    let params = format!("container={}", e.container);
    // A shell or attach the user asked for in a container that was already there: refused in read-only mode.
    // (Debug containers and node shells were refused before anything was created for them.)
    if !e.starting
        && let Err(err) = inner.guard_write()
    {
        ops::audit(&e.pod, action, &params, &Err::<(), _>(err));
        return Ok(Ending::failed(Error::ReadOnly.message()));
    }
    // (A container created for the session is being waited for already: no step back to "connecting".)
    if !e.starting {
        out.state(State::Connecting, None)?;
    }
    let cluster = match ops::connected(inner, &e.pod.cluster, false).await {
        Ok(c) => c,
        Err(err) => return Ok(Ending::Failed(err.message())),
    };
    let api: Api<Pod> = Api::namespaced(cluster.client.clone(), e.pod.namespace.as_deref().unwrap_or_default());
    let pod = match until_running(inner, &api, e, out, control, &mut size).await? {
        Ok(pod) => pod,
        Err(why) => return Ok(Ending::Failed(why)),
    };
    // Waiting may have taken a while: read-only mode may be on by now.
    if let Err(err) = inner.guard_write() {
        ops::audit(&e.pod, action, &params, &Err::<(), _>(err));
        return Ok(Ending::failed(Error::ReadOnly.message()));
    }
    let process = match open(inner, &cluster, &api, e, pod.as_ref()).await {
        Ok(p) => p,
        Err(err) => {
            let why = open_failure(&err, e, crate::access::stream_verb(cluster.version.as_deref()));
            ops::audit(&e.pod, action, &params, &Err::<(), _>(err));
            return Ok(Ending::Failed(why));
        }
    };
    ops::audit(&e.pod, action, &params, &Ok::<(), Error>(()));
    tracing::debug!(cluster = %e.pod.cluster, pod = %e.pod.name, container = %e.container, action, "terminal opened");
    out.state(State::Open, None)?;
    let ending = pump(process, size, out, control).await?;
    tracing::debug!(cluster = %e.pod.cluster, pod = %e.pod.name, container = %e.container, ?ending, "terminal closed");
    Ok(ending)
}

/// Opens the stream; rejected credentials are renewed and the opening tried once more.
async fn open(inner: &Arc<Inner>, cluster: &Cluster, api: &Api<Pod>, e: &Entry, pod: Option<&Value>) -> Result<AttachedProcess> {
    let ap = AttachParams::interactive_tty().container(e.container.clone()).max_stdin_buf_size(CHUNK).max_stdout_buf_size(CHUNK);
    let attempt = || async {
        let opening = async {
            match e.how {
                How::Shell => api.exec(&e.pod.name, shell_command(pod), &ap).await,
                How::Attach => api.attach(&e.pod.name, &ap).await,
                How::NodeShell => api.exec(&e.pod.name, node_shell_command(), &ap).await,
            }
        };
        match tokio::time::timeout(OPEN_TIMEOUT, opening).await {
            Ok(res) => res.map_err(Error::from),
            Err(_) => Err(Error::other(format!("the stream did not open within {}s (is the node reachable?)", OPEN_TIMEOUT.as_secs()))),
        }
    };
    match attempt().await {
        Err(err) if rejected(&err) && inner.reauthenticate(&cluster.context).await => attempt().await,
        res => res,
    }
}

/// The status code the API server answered the stream's opening with (kube keeps nothing else of it).
fn switch_code(err: &Error) -> Option<u16> {
    match err {
        Error::Kube(kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(code))) => Some(code.as_u16()),
        _ => err.code(),
    }
}

fn rejected(err: &Error) -> bool {
    switch_code(err) == Some(401) || matches!(err, Error::Kube(e) if crate::cluster::is_auth_failure(e))
}

/// Why the stream did not open, in words: the API server's answer itself is lost on the way (kube keeps only
/// its status code), but the container was found running a moment ago, which leaves few explanations.
fn open_failure(err: &Error, e: &Entry, verb: &str) -> String {
    let ns = e.pod.namespace.as_deref().unwrap_or_default();
    let sub = if e.how == How::Attach { "attach" } else { "exec" };
    match switch_code(err) {
        Some(401) => "credentials rejected: reconnect the cluster and try again".into(),
        Some(403) => format!("no permission to open a terminal in namespace \"{ns}\": it takes {verb} on pods/{sub}"),
        Some(404) => format!("pod \"{}\" not found: it was deleted", e.pod.name),
        Some(400) => format!("the API server refused: container \"{}\" stopped running, or the request was not valid here", e.container),
        Some(code @ 500..) => format!("the API server could not reach the node's kubelet (HTTP {code})"),
        _ => err.message(),
    }
}

/// What a pod's container is doing, for a session about to enter it.
#[derive(Debug, PartialEq)]
enum Readiness {
    Running,
    /// Not yet (being created, pulling its image): worth waiting for when it was just created.
    Starting(String),
    /// It will not run (gone, finished, failing to start): the reason.
    Never(String),
}

/// Waits until the container runs and returns its pod (`None`: the pod could not be read, the stream is opened
/// all the same). A container that does not run is reported at once — unless it was created for the session,
/// then it is waited for (up to [`WAIT_FOR_RUNNING`]), keystrokes meanwhile dropped, resizes kept.
async fn until_running(
    inner: &Inner,
    api: &Api<Pod>,
    e: &Entry,
    out: &Out,
    control: &mut mpsc::UnboundedReceiver<Control>,
    size: &mut TermSize,
) -> Result<Result<Option<Value>, String>, Closed> {
    let deadline = Instant::now() + WAIT_FOR_RUNNING;
    // The shared feeds first (no request): they hold the pod the user picked from a table, not yet one just created.
    let mut pod = if e.starting { None } else { inner.hub.find_object(&e.pod.cluster, "pods", e.pod.namespace.as_deref(), &e.pod.name, None) };
    loop {
        let found = match pod.take() {
            Some(json) => Ok(serde_json::from_str::<Value>(&json).unwrap_or(Value::Null)),
            None => match tokio::time::timeout(ops::READ_TIMEOUT, api.get_opt(&e.pod.name)).await {
                Ok(Ok(Some(p))) => Ok(serde_json::to_value(&p).unwrap_or(Value::Null)),
                Ok(Ok(None)) => return Ok(Err(format!("pod \"{}\" not found: it was deleted", e.pod.name))),
                Ok(Err(err)) => Err(Error::from(err)),
                Err(_) => Err(Error::other(format!("no answer from the API server within {}s", ops::READ_TIMEOUT.as_secs()))),
            },
        };
        let (readiness, json) = match found {
            Ok(json) if !json.is_null() => (readiness(&json, &e.container, e.pod.uid.as_deref()), json),
            // Not allowed to read the pod (opening a terminal may still be), or no answer: open it and see.
            Ok(_) | Err(_) if !e.starting => return Ok(Ok(None)),
            Err(err) if err.code() == Some(403) => return Ok(Err(err.message())),
            Ok(_) => (Readiness::Starting("waiting for the API server".into()), Value::Null),
            // Created a moment ago: the network or the API server may be slow, keep looking until the deadline.
            Err(err) => (Readiness::Starting(format!("could not read the pod: {}", err.message())), Value::Null),
        };
        match readiness {
            Readiness::Running => return Ok(Ok(Some(json))),
            Readiness::Never(why) => return Ok(Err(why)),
            Readiness::Starting(why) if !e.starting => return Ok(Err(format!("container \"{}\" is not running: {why}", e.container))),
            Readiness::Starting(why) if Instant::now() >= deadline => {
                return Ok(Err(format!("container \"{}\" did not start within {}s: {why}", e.container, WAIT_FOR_RUNNING.as_secs())));
            }
            Readiness::Starting(why) => {
                out.state(State::Waiting, Some(&why))?;
                let sleep = tokio::time::sleep(POLL);
                tokio::pin!(sleep);
                loop {
                    tokio::select! {
                        _ = &mut sleep => break,
                        c = control.recv() => match c {
                            Some(Control::Resize(s)) => *size = s,
                            Some(_) => {}
                            None => return Err(Closed),
                        },
                    }
                }
            }
        }
    }
}

/// Waiting reasons a container does not get out of by itself: waiting for it is pointless.
const STUCK: [&str; 6] = ["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError", "CreateContainerError"];

/// What `container` (a regular, init or ephemeral one) of `pod` is doing. `uid`: the pod picked.
fn readiness(pod: &Value, container: &str, uid: Option<&str>) -> Readiness {
    if let Some(uid) = uid.filter(|u| !u.is_empty() && !u.contains('/'))
        && pod.pointer("/metadata/uid").and_then(Value::as_str).is_some_and(|u| u != uid)
    {
        return Readiness::Never("the pod was re-created since you picked it".into());
    }
    let phase = pod.pointer("/status/phase").and_then(Value::as_str).unwrap_or_default();
    let named = |list: &str| pod.pointer(list).and_then(Value::as_array).and_then(|cs| cs.iter().find(|c| c["name"] == container).cloned());
    let status = ["/status/containerStatuses", "/status/ephemeralContainerStatuses", "/status/initContainerStatuses"].iter().find_map(|l| named(l));
    let Some(status) = status else {
        let declared = ["/spec/containers", "/spec/ephemeralContainers", "/spec/initContainers"].iter().any(|l| named(l).is_some());
        if !declared {
            return Readiness::Never(format!("the pod has no container \"{container}\""));
        }
        if matches!(phase, "Succeeded" | "Failed") {
            return Readiness::Never(format!("the pod has {}", phase.to_lowercase()));
        }
        let unscheduled = pod
            .pointer("/status/conditions")
            .and_then(Value::as_array)
            .and_then(|cs| cs.iter().find(|c| c["type"] == "PodScheduled" && c["status"] == "False"));
        return Readiness::Starting(match unscheduled {
            Some(c) => format!("not scheduled: {}", c["message"].as_str().or(c["reason"].as_str()).unwrap_or("pending")),
            None => "creating".into(),
        });
    };
    let state = &status["state"];
    if state.get("running").is_some() {
        return Readiness::Running;
    }
    if let Some(t) = state.get("terminated") {
        let reason = t["reason"].as_str().unwrap_or("Terminated");
        let code = t["exitCode"].as_i64().map(|c| format!(", exit code {c}")).unwrap_or_default();
        return Readiness::Never(format!("container \"{container}\" has exited ({reason}{code})"));
    }
    let waiting = &state["waiting"];
    let reason = waiting["reason"].as_str().unwrap_or("waiting to start");
    let text = match waiting["message"].as_str().filter(|m| !m.is_empty()) {
        Some(m) => format!("{reason}: {m}"),
        None => reason.to_string(),
    };
    if STUCK.contains(&reason) || matches!(phase, "Succeeded" | "Failed") { Readiness::Never(text) } else { Readiness::Starting(text) }
}

/// Moves keystrokes in and output out until the process ends (or the connection breaks).
async fn pump(mut process: AttachedProcess, size: TermSize, out: &Out, control: &mut mpsc::UnboundedReceiver<Control>) -> Result<Ending, Closed> {
    let (Some(mut stdin), Some(mut stdout)) = (process.stdin(), process.stdout()) else {
        return Ok(Ending::failed("the stream has no terminal"));
    };
    let mut resize = process.terminal_size();
    let status = process.take_status();
    let status = async move {
        match status {
            Some(s) => s.await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(status);
    if let Some(r) = resize.as_mut() {
        let _ = r.send(TerminalSize { width: size.cols, height: size.rows }).await;
    }
    let mut buf = vec![0u8; CHUNK];
    let mut unacked = 0usize;
    let mut exit: Option<Option<Status>> = None;
    let mut broken: Option<String> = None;
    let mut input_open = true;
    loop {
        tokio::select! {
            read = stdout.read(&mut buf), if unacked < HIGH_WATER => match read {
                // The output ended: the process exited (its status follows, or came first) or the stream broke.
                Ok(0) => break,
                Ok(n) => {
                    unacked += n;
                    out.output(&buf[..n])?;
                }
                Err(e) => {
                    broken = Some(e.to_string());
                    break;
                }
            },
            c = control.recv() => match c {
                Some(Control::Input(bytes)) if input_open => {
                    // The process stopped reading (it exited): its status and the rest of the output follow.
                    if stdin.write_all(&bytes).await.is_err() {
                        input_open = false;
                    }
                }
                Some(Control::Input(_)) => {}
                Some(Control::Resize(s)) => {
                    if let Some(r) = resize.as_mut() {
                        let _ = r.send(TerminalSize { width: s.cols, height: s.rows }).await;
                    }
                }
                Some(Control::Ack(n)) => unacked = unacked.saturating_sub(n),
                None => return Err(Closed),
            },
            s = &mut status, if exit.is_none() => exit = Some(s),
        }
    }
    let exit = match exit {
        Some(s) => s,
        None => tokio::time::timeout(EXIT_GRACE, &mut status).await.ok().flatten(),
    };
    // Dropping the process stops its message loop (should it still run).
    drop(process);
    Ok(match (exit, broken) {
        (Some(s), _) => ending_of(&s),
        (None, Some(why)) => Ending::Failed(format!("connection lost: {why}")),
        (None, None) => Ending::Exited(None),
    })
}

/// How the process ended, from the status the API server sends: `Success`, a non-zero exit code
/// (`NonZeroExitCode` with an `ExitCode` cause), or why it could not run.
fn ending_of(s: &Status) -> Ending {
    if s.status.as_deref() == Some("Success") {
        return Ending::Exited(Some(0));
    }
    let code = s
        .details
        .as_ref()
        .and_then(|d| d.causes.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
        .and_then(|c| c.message.as_deref())
        .and_then(|m| m.trim().parse().ok());
    if s.reason.as_deref() == Some("NonZeroExitCode")
        && let Some(code) = code
    {
        return Ending::Exited(Some(code));
    }
    let message = s.message.clone().unwrap_or_else(|| s.reason.clone().unwrap_or_else(|| "the process failed".into()));
    // `… OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not
    // found in $PATH: unknown` — a distroless or scratch image. What matters is at the end.
    if message.contains("executable file not found") || message.contains("no such file or directory") {
        let why = message.find("exec: \"").map_or(message.as_str(), |at| &message[at..]).trim_end_matches(": unknown");
        return Ending::Failed(format!("the container has no shell ({why}): a debug container can look inside it"));
    }
    Ending::Failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};
    use serde_json::json;

    fn pod(status: Value) -> Value {
        json!({
            "metadata": { "name": "web-1", "uid": "uid-1" },
            "spec": { "containers": [{ "name": "app" }, { "name": "sidecar" }], "ephemeralContainers": [{ "name": "debugger-x" }] },
            "status": status,
        })
    }

    #[test]
    fn a_containers_readiness_comes_from_its_status() {
        let running = pod(json!({ "phase": "Running", "containerStatuses": [{ "name": "app", "state": { "running": {} } }] }));
        assert_eq!(readiness(&running, "app", Some("uid-1")), Readiness::Running);
        // The pod picked was deleted and another created under its name.
        assert!(matches!(readiness(&running, "app", Some("uid-0")), Readiness::Never(m) if m.contains("re-created")));
        // A synthetic uid (`namespace/name`, objects without one) is no precondition.
        assert_eq!(readiness(&running, "app", Some("default/web-1")), Readiness::Running);
        assert!(matches!(readiness(&running, "db", None), Readiness::Never(m) if m.contains("no container \"db\"")));
        // Declared, no status yet: being created.
        assert_eq!(readiness(&running, "sidecar", None), Readiness::Starting("creating".into()));
        assert_eq!(readiness(&running, "debugger-x", None), Readiness::Starting("creating".into()));

        let pulling = pod(
            json!({ "phase": "Running", "ephemeralContainerStatuses": [{ "name": "debugger-x", "state": { "waiting": { "reason": "ContainerCreating" } } }] }),
        );
        assert_eq!(readiness(&pulling, "debugger-x", None), Readiness::Starting("ContainerCreating".into()));
        let bad_image = pod(
            json!({ "ephemeralContainerStatuses": [{ "name": "debugger-x", "state": { "waiting": { "reason": "ErrImagePull", "message": "not found" } } }] }),
        );
        assert_eq!(readiness(&bad_image, "debugger-x", None), Readiness::Never("ErrImagePull: not found".into()));
        let crashed = pod(json!({ "containerStatuses": [{ "name": "app", "state": { "terminated": { "reason": "Error", "exitCode": 2 } } }] }));
        assert_eq!(readiness(&crashed, "app", None), Readiness::Never("container \"app\" has exited (Error, exit code 2)".into()));
        let crash_looping = pod(
            json!({ "phase": "Running", "containerStatuses": [{ "name": "app", "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 5m0s" } } }] }),
        );
        assert_eq!(readiness(&crash_looping, "app", None), Readiness::Starting("CrashLoopBackOff: back-off 5m0s".into()));

        let unschedulable = pod(
            json!({ "phase": "Pending", "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "0/3 nodes are available" }] }),
        );
        assert_eq!(readiness(&unschedulable, "app", None), Readiness::Starting("not scheduled: 0/3 nodes are available".into()));
        let finished = pod(json!({ "phase": "Succeeded" }));
        assert_eq!(readiness(&finished, "app", None), Readiness::Never("the pod has succeeded".into()));
    }

    fn status(status: &str, reason: Option<&str>, message: Option<&str>, exit: Option<&str>) -> Status {
        Status {
            status: Some(status.into()),
            reason: reason.map(Into::into),
            message: message.map(Into::into),
            details: exit.map(|code| StatusDetails {
                causes: Some(vec![StatusCause { reason: Some("ExitCode".into()), message: Some(code.into()), field: None }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn the_end_of_a_process_is_read_from_its_status() {
        assert_eq!(ending_of(&status("Success", None, None, None)), Ending::Exited(Some(0)));
        assert_eq!(
            ending_of(&status("Failure", Some("NonZeroExitCode"), Some("command terminated with non-zero exit code"), Some("130"))),
            Ending::Exited(Some(130))
        );
        let no_shell = ending_of(&status(
            "Failure",
            Some("InternalError"),
            Some(
                r#"Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "aa73": OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown"#,
            ),
            None,
        ));
        assert_eq!(
            no_shell,
            Ending::Failed(r#"the container has no shell (exec: "sh": executable file not found in $PATH): a debug container can look inside it"#.into())
        );
        assert_eq!(ending_of(&status("Failure", Some("InternalError"), None, None)), Ending::Failed("InternalError".into()));
    }

    #[test]
    fn windows_pods_get_cmd_and_others_their_best_shell() {
        let linux = json!({ "spec": { "containers": [] } });
        assert_eq!(shell_command(Some(&linux)), ["sh", "-c", SHELL]);
        assert_eq!(shell_command(None), ["sh", "-c", SHELL]);
        assert_eq!(shell_command(Some(&json!({ "spec": { "os": { "name": "windows" } } }))), ["cmd"]);
        assert_eq!(shell_command(Some(&json!({ "spec": { "nodeSelector": { "kubernetes.io/os": "windows" } } }))), ["cmd"]);
    }

    #[test]
    fn the_node_shell_pod_shares_the_nodes_namespaces_and_tolerates_everything() {
        let spec =
            NodeShellSpec { cluster: "c".into(), node: "node-a".into(), namespace: "default".into(), image: "busybox:1.37".into(), size: TermSize::default() };
        let p = node_shell_pod(&spec);
        assert_eq!(p["spec"]["nodeName"], "node-a");
        assert_eq!((p["spec"]["hostPID"].clone(), p["spec"]["hostNetwork"].clone(), p["spec"]["hostIPC"].clone()), (json!(true), json!(true), json!(true)));
        assert_eq!(p["spec"]["tolerations"], json!([{ "operator": "Exists" }]));
        assert_eq!(p["spec"]["containers"][0]["securityContext"]["privileged"], true);
        assert_eq!(p["spec"]["containers"][0]["name"], NODE_SHELL_CONTAINER);
        assert_eq!(p["metadata"]["labels"]["app.kubernetes.io/managed-by"], "k10s");
        assert_eq!(&node_shell_command()[..9], ["nsenter", "--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_shell_prefers_bash_then_ash_then_sh() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("k10s-shell-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink("/bin/sh", dir.join("sh")).unwrap();
        let fake = |name: &str| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\necho {name} \"$TERM\"\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // What the script ends up running, with only `dir` on the PATH (and no terminal type set).
        let run = || {
            let script = format!("unset TERM; PATH={}; {SHELL}", dir.display());
            let out = std::process::Command::new("/bin/sh").args(["-c", &script]).stdin(std::process::Stdio::null()).output().unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        };
        // Neither bash nor ash: sh, reading no input, exits at once.
        assert_eq!(run(), "");
        fake("ash");
        assert_eq!(run(), "ash xterm-256color\n");
        fake("bash");
        assert_eq!(run(), "bash xterm-256color\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
