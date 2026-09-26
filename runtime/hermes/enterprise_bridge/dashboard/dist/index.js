/**
 * Enterprise Bridge — read-only runtime status for the Hermes dashboard.
 *
 * Plain IIFE so the pinned dashboard can load it without a frontend build.
 * The readiness document is already non-secret and is exposed through the
 * authenticated managed-files API; this pane never calls the machine-only
 * Enterprise control route.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry) return;

  const { React } = SDK;
  const h = React.createElement;
  const { useCallback, useEffect, useState } = SDK.hooks;
  const { Button } = SDK.components;
  const READINESS_FILE = "runtime-readiness.json";

  function shortRevision(value) {
    return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : value || "—";
  }

  function decodeDataUrl(dataUrl) {
    if (typeof dataUrl !== "string") throw new Error("The readiness file had no content.");
    const comma = dataUrl.indexOf(",");
    if (comma === -1 || !dataUrl.slice(0, comma).includes(";base64")) {
      throw new Error("The readiness file response was malformed.");
    }
    const binary = window.atob(dataUrl.slice(comma + 1));
    const bytes = Uint8Array.from(binary, function (character) {
      return character.charCodeAt(0);
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function validateReadiness(value) {
    const valid = value && value.schema_version === 1 && value.managed_cloud === true
      && value.native_cron_disabled === true && typeof value.runtime_revision === "string"
      && value.plugin && typeof value.plugin === "object"
      && typeof value.plugin.name === "string" && typeof value.plugin.version === "string"
      && typeof value.plugin.revision === "string"
      && typeof value.plugin.artifact_digest === "string"
      && Array.isArray(value.tools) && value.tools.every(function (item) { return typeof item === "string"; })
      && Array.isArray(value.skills) && value.skills.every(function (item) {
        return item && typeof item === "object" && typeof item.name === "string";
      });
    if (!valid) throw new Error("The gateway readiness attestation is incomplete.");
    return value;
  }

  async function readReadiness() {
    const listing = await SDK.fetchJSON("/api/files");
    const entries = listing && Array.isArray(listing.entries) ? listing.entries : [];
    const file = entries.find(function (entry) {
      return entry && entry.name === READINESS_FILE && entry.is_directory === false;
    });
    if (!file || typeof file.path !== "string") {
      throw new Error("The gateway has not published a readiness attestation yet.");
    }
    const response = await SDK.fetchJSON("/api/files/read?path=" + encodeURIComponent(file.path));
    return validateReadiness(JSON.parse(decodeDataUrl(response && response.data_url)));
  }

  function Detail(props) {
    return h("div", { className: "enterprise-bridge-detail" },
      h("dt", null, props.label),
      h("dd", { title: props.title || undefined }, props.value)
    );
  }

  function EnterpriseBridgePage() {
    const [state, setState] = useState({ status: "loading" });

    const refresh = useCallback(function () {
      setState({ status: "loading" });
      readReadiness().then(function (readiness) {
        setState({ status: "ready", readiness: readiness });
      }).catch(function (error) {
        setState({
          status: "unavailable",
          message: error && error.message ? error.message : "Runtime status is unavailable.",
        });
      });
    }, []);

    useEffect(function () {
      refresh();
    }, [refresh]);

    const ready = state.status === "ready";
    const readiness = ready ? state.readiness : null;
    const plugin = readiness ? readiness.plugin : null;
    const badgeLabel = state.status === "loading" ? "Checking" : (ready ? "Ready" : "Unavailable");

    return h("main", { className: "enterprise-bridge-page" },
      h("div", { className: "enterprise-bridge-heading" },
        h("div", null,
          h("h1", null, "Enterprise bridge"),
          h("p", null, "Verified status for this managed Hermes Runtime.")
        ),
        h(Button, { variant: "outline", onClick: refresh, disabled: state.status === "loading" },
          state.status === "loading" ? "Checking…" : "Refresh"
        )
      ),
      h("section", { className: "enterprise-bridge-card", "aria-live": "polite" },
        h("div", { className: "enterprise-bridge-status-row" },
          h("span", {
            className: "enterprise-bridge-dot " + (ready ? "is-ready" : "is-unavailable"),
            "aria-hidden": "true",
          }),
          h("div", null,
            h("h2", null, badgeLabel),
            h("p", null, ready
              ? "The gateway is running with an exact, attested Enterprise plugin and policy."
              : (state.status === "loading" ? "Reading the gateway attestation…" : state.message))
          )
        ),
        ready ? h("dl", { className: "enterprise-bridge-grid" },
          h(Detail, {
            label: "Hermes runtime",
            value: shortRevision(readiness.runtime_revision),
            title: readiness.runtime_revision,
          }),
          h(Detail, {
            label: "Enterprise plugin",
            value: plugin.version + " · " + shortRevision(plugin.revision),
            title: plugin.revision,
          }),
          h(Detail, {
            label: "Available tools",
            value: String(readiness.tools.length),
          }),
          h(Detail, {
            label: "Assigned skills",
            value: String(readiness.skills.length),
          }),
          h(Detail, {
            label: "Native scheduling",
            value: "Disabled",
          }),
          h(Detail, {
            label: "Managed cloud",
            value: "Enabled",
          })
        ) : null
      ),
      h("section", { className: "enterprise-bridge-note" },
        h("h2", null, "Enterprise routing"),
        h("p", null,
          "Hermes Runs are routed through Enterprise. You can switch among allowed models without changing the authenticated provider route."
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("enterprise_bridge", EnterpriseBridgePage);
})();
