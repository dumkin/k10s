use serde_json::Value;

use super::util::{JsonExt, join, join_map, truncate_list};
use super::{Add, Cell, ColumnKind as K, Tone, col};

pub fn register(add: &mut Add<'_>) {
    add(
        "",
        "Service",
        vec![
            col("type", "Type", K::Text).w(110),
            col("clusterIP", "Cluster IP", K::Text).w(120),
            col("externalIP", "External IP", K::Status).w(140),
            col("ports", "Ports", K::Text).w(180),
            col("selector", "Selector", K::Text).w(220).hidden(),
        ],
        service,
    );
    add(
        "networking.k8s.io",
        "Ingress",
        vec![
            col("class", "Class", K::Text).w(100),
            col("hosts", "Hosts", K::Text).w(260),
            col("address", "Address", K::Text).w(150),
            col("ports", "Ports", K::Text).w(80),
        ],
        ingress,
    );
    add("networking.k8s.io", "IngressClass", vec![col("controller", "Controller", K::Text).w(260), col("default", "Default", K::Bool).w(80)], ingress_class);
    add("", "Endpoints", vec![col("endpoints", "Endpoints", K::Text).w(320)], endpoints);
    add(
        "discovery.k8s.io",
        "EndpointSlice",
        vec![col("addressType", "Address Type", K::Text).w(110), col("ports", "Ports", K::Text).w(120), col("endpoints", "Endpoints", K::Text).w(280)],
        endpoint_slice,
    );
    add(
        "networking.k8s.io",
        "NetworkPolicy",
        vec![col("podSelector", "Pod Selector", K::Text).w(260), col("policyTypes", "Policy Types", K::Text).w(140)],
        network_policy,
    );
}

fn service(o: &Value) -> (Vec<Cell>, Tone) {
    let typ = o.str_at(&["spec", "type"]).unwrap_or("ClusterIP");
    let external_ips: Vec<&str> = o.arr(&["spec", "externalIPs"]).iter().filter_map(Value::as_str).collect();
    let external = match typ {
        "ExternalName" => Cell::status(o.str_at(&["spec", "externalName"]).unwrap_or_default(), Tone::Neutral),
        "LoadBalancer" => {
            let mut ips: Vec<&str> =
                o.arr(&["status", "loadBalancer", "ingress"]).iter().filter_map(|i| i.str_at(&["ip"]).or_else(|| i.str_at(&["hostname"]))).collect();
            ips.extend(external_ips.iter().copied());
            if ips.is_empty() { Cell::status("<pending>", Tone::Warn) } else { Cell::status(ips.join(","), Tone::Neutral) }
        }
        _ if !external_ips.is_empty() => Cell::status(external_ips.join(","), Tone::Neutral),
        _ => Cell::Null,
    };
    let ports: Vec<String> = o
        .arr(&["spec", "ports"])
        .iter()
        .map(|p| {
            let port = p.i64_at(&["port"]).unwrap_or(0);
            let proto = p.str_at(&["protocol"]).unwrap_or("TCP");
            match p.i64_at(&["nodePort"]) {
                Some(np) => format!("{port}:{np}/{proto}"),
                None => format!("{port}/{proto}"),
            }
        })
        .collect();
    let cells = vec![
        Cell::text(typ),
        Cell::opt_text(o.str_at(&["spec", "clusterIP"])),
        external,
        Cell::opt_text((!ports.is_empty()).then(|| ports.join(",")).as_deref()),
        Cell::opt_text(join_map(o.at(&["spec", "selector"])).as_deref()),
    ];
    (cells, Tone::Neutral)
}

fn ingress(o: &Value) -> (Vec<Cell>, Tone) {
    let class = o.str_at(&["spec", "ingressClassName"]).or_else(|| o.str_at(&["metadata", "annotations", "kubernetes.io/ingress.class"]));
    let rules = o.arr(&["spec", "rules"]);
    let hosts = if rules.is_empty() { Some("*".to_string()) } else { join(rules.iter().map(|r| r.str_at(&["host"]).unwrap_or("*"))) };
    let address = join(o.arr(&["status", "loadBalancer", "ingress"]).iter().filter_map(|i| i.str_at(&["ip"]).or_else(|| i.str_at(&["hostname"]))));
    let ports = if o.arr(&["spec", "tls"]).is_empty() { "80" } else { "80, 443" };
    (vec![Cell::opt_text(class), Cell::opt_text(hosts.as_deref()), Cell::opt_text(address.as_deref()), Cell::text(ports)], Tone::Neutral)
}

fn ingress_class(o: &Value) -> (Vec<Cell>, Tone) {
    let default = o.str_at(&["metadata", "annotations", "ingressclass.kubernetes.io/is-default-class"]) == Some("true");
    (vec![Cell::opt_text(o.str_at(&["spec", "controller"])), Cell::Bool(default)], Tone::Neutral)
}

fn endpoints(o: &Value) -> (Vec<Cell>, Tone) {
    let mut list = Vec::new();
    for subset in o.arr(&["subsets"]) {
        let ports: Vec<i64> = subset.arr(&["ports"]).iter().filter_map(|p| p.i64_at(&["port"])).collect();
        for addr in subset.arr(&["addresses"]) {
            let ip = addr.str_at(&["ip"]).unwrap_or_default();
            if ports.is_empty() {
                list.push(ip.to_string());
            }
            for port in &ports {
                list.push(format!("{ip}:{port}"));
            }
        }
    }
    let tone = if list.is_empty() { Tone::Warn } else { Tone::Neutral };
    (vec![Cell::opt_text(truncate_list(&list, 3).as_deref().or(Some("<none>")))], tone)
}

fn endpoint_slice(o: &Value) -> (Vec<Cell>, Tone) {
    let ports: Vec<String> = o.arr(&["ports"]).iter().filter_map(|p| p.i64_at(&["port"])).map(|n| n.to_string()).collect();
    let ports = (!ports.is_empty()).then(|| ports.join(","));
    let addrs: Vec<String> = o.arr(&["endpoints"]).iter().flat_map(|e| e.arr(&["addresses"]).iter().filter_map(Value::as_str).map(str::to_string)).collect();
    let tone = if addrs.is_empty() { Tone::Warn } else { Tone::Neutral };
    (
        vec![
            Cell::opt_text(o.str_at(&["addressType"])),
            Cell::opt_text(ports.as_deref()),
            Cell::opt_text(truncate_list(&addrs, 3).as_deref().or(Some("<unset>"))),
        ],
        tone,
    )
}

fn network_policy(o: &Value) -> (Vec<Cell>, Tone) {
    let selector = join_map(o.at(&["spec", "podSelector", "matchLabels"])).unwrap_or_else(|| "<none>".into());
    let types = join(o.arr(&["spec", "policyTypes"]).iter().filter_map(Value::as_str));
    (vec![Cell::text(selector), Cell::opt_text(types.as_deref())], Tone::Neutral)
}
