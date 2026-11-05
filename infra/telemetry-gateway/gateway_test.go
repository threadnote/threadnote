package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/quick"
	"time"

	"github.com/threadnote/threadnote/infra/telemetry-gateway/internal/budget"
	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

func TestIngressRejectsRequestsOutsideTheContract(t *testing.T) {
	tests := []struct {
		body        []byte
		contentType string
		encoding    string
		method      string
		target      string
		wantStatus  int
	}{
		{method: http.MethodGet, target: "/other", wantStatus: http.StatusNotFound},
		{method: http.MethodGet, target: "/v1/traces?private=value", wantStatus: http.StatusNotFound},
		{method: http.MethodGet, target: "/v1/traces", wantStatus: http.StatusMethodNotAllowed},
		{body: []byte("{}"), contentType: "application/json", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{body: []byte{1}, contentType: "application/x-protobuf; charset=binary", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{body: []byte{1}, contentType: "application/x-protobuf", encoding: "gzip", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusUnsupportedMediaType},
		{contentType: "application/x-protobuf", method: http.MethodPost, target: "/v1/traces", wantStatus: http.StatusBadRequest},
	}

	for _, test := range tests {
		handler, handlerError := newGatewayHandler()
		if handlerError != nil {
			t.Fatal(handlerError)
		}
		request := httptest.NewRequest(test.method, test.target, bytes.NewReader(test.body))
		if test.contentType != "" {
			request.Header.Set("Content-Type", test.contentType)
		}
		if test.encoding != "" {
			request.Header.Set("Content-Encoding", test.encoding)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.wantStatus {
			t.Fatalf("%s %s returned %d, want %d", test.method, test.target, response.Code, test.wantStatus)
		}
	}
}

func TestIngressCapsBodiesBeforeCollectorParsing(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(make([]byte, maxRequestBytes+1)))
	request.Header.Set("Content-Type", "application/x-protobuf")
	request.ContentLength = -1
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request returned %d, want %d", response.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestIngressForwardsOnlyProtobufAndStripsInboundMetadata(t *testing.T) {
	type capture struct {
		authorization string
		baggage       string
		body          []byte
		clientIP      string
		traceparent   string
	}
	captured := make(chan capture, 1)
	listener, listenError := net.Listen("tcp", "127.0.0.1:4318")
	if listenError != nil {
		t.Fatal(listenError)
	}
	backend := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		captured <- capture{
			authorization: request.Header.Get("Authorization"),
			baggage:       request.Header.Get("Baggage"),
			body:          body,
			clientIP:      request.Header.Get("Fly-Client-IP"),
			traceparent:   request.Header.Get("Traceparent"),
		}
		response.Header().Set("Content-Type", "application/x-protobuf")
		response.WriteHeader(http.StatusOK)
	})}
	go func() { _ = backend.Serve(listener) }()
	t.Cleanup(func() { _ = backend.Close() })

	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	payload := validTelemetryPayload(t)
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer private")
	request.Header.Set("Baggage", "private=value")
	request.Header.Set("Content-Type", "application/x-protobuf")
	request.Header.Set("Fly-Client-IP", "192.0.2.42")
	request.Header.Set("Traceparent", "00-private")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid request returned %d, want %d", response.Code, http.StatusOK)
	}
	if response.Header().Get("Content-Type") != "application/x-protobuf" {
		t.Fatalf("valid response content type = %q", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Strict-Transport-Security") != "max-age=31536000" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("fixed security response headers were not set")
	}

	select {
	case result := <-captured:
		if result.authorization != "" || result.baggage != "" || result.clientIP != "" || result.traceparent != "" {
			t.Fatalf("private inbound headers reached Collector: %#v", result)
		}
		if !bytes.Equal(result.body, payload) {
			t.Fatalf("forwarded payload = %v, want %v", result.body, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("Collector did not receive the request")
	}
}

func validTelemetryPayload(t *testing.T) []byte {
	t.Helper()
	request := validTelemetryRequest()
	payload, err := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func validTelemetryRequest() *collectortracepb.ExportTraceServiceRequest {
	attribute := func(key string, value *commonpb.AnyValue) *commonpb.KeyValue {
		return &commonpb.KeyValue{Key: key, Value: value}
	}
	request := &collectortracepb.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
			attribute("service.name", stringAnyValue("threadnote")),
			attribute("service.version", stringAnyValue("4.2.2")),
			attribute("session.id", stringAnyValue("tns_000102030405060708090a0b0c0d0e0f")),
			attribute("threadnote.session.scope", stringAnyValue("invocation")),
			attribute("threadnote.telemetry.schema_version", intAnyValue(1)),
		}},
		ScopeSpans: []*tracepb.ScopeSpans{{
			Scope: &commonpb.InstrumentationScope{Name: "threadnote"},
			Spans: []*tracepb.Span{{
				TraceId: bytes.Repeat([]byte{1}, 16), SpanId: bytes.Repeat([]byte{2}, 8),
				Name: "threadnote.anonymous-diagnostic", Kind: tracepb.Span_SPAN_KIND_INTERNAL,
				StartTimeUnixNano: 1, EndTimeUnixNano: 2,
				Attributes: []*commonpb.KeyValue{
					attribute("threadnote.component", stringAnyValue("cli")),
					attribute("threadnote.event", stringAnyValue("completion")),
					attribute("threadnote.operation", stringAnyValue("health")),
					attribute("threadnote.runtime.architecture", stringAnyValue("arm64")),
					attribute("threadnote.runtime.platform", stringAnyValue("darwin")),
					attribute("threadnote.runtime.version", stringAnyValue("1.3.14")),
					attribute("threadnote.duration_ms", intAnyValue(1)),
					attribute("threadnote.outcome", stringAnyValue("success")),
				},
				Status: &tracepb.Status{Code: tracepb.Status_STATUS_CODE_OK},
			}},
		}},
	}}}
	return request
}

func validTelemetryV2Request() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryRequest()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(2)
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("lifecycle")
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("graph-build")
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.graph.build_kind", "dirty"),
		stringKeyValue("threadnote.graph.materialization_mode", "full"),
		stringKeyValue("threadnote.graph.fallback_reason", "resolution-surface-changed"),
		stringKeyValue("threadnote.graph.resolution_closure", "full"),
		stringKeyValue("threadnote.graph.efficiency_class", "high-amplification-full"),
	)
	for _, key := range []string{
		"threadnote.graph.changed_files_bucket",
		"threadnote.graph.deleted_files_bucket",
		"threadnote.graph.delta_files_bucket",
		"threadnote.graph.extracted_files_bucket",
		"threadnote.graph.reused_files_bucket",
		"threadnote.graph.staged_files_bucket",
		"threadnote.graph.total_files_bucket",
		"threadnote.graph.cached_fact_replay_bytes_bucket",
		"threadnote.graph.changed_fact_bytes_bucket",
		"threadnote.graph.final_fact_bytes_bucket",
		"threadnote.graph.rewrite_amplification_bucket",
		"threadnote.graph.fact_replay_amplification_bucket",
	} {
		span.Attributes = append(span.Attributes, stringKeyValue(key, "2^1"))
	}
	return request
}

func validTelemetryV2CompletionRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryRequest()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(2)
	return request
}

func validTelemetryV3GraphRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV2Request()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(3)
	return request
}

func validTelemetryAutoUpdateRequest(schemaVersion int64, repairRequired bool) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryAutoUpdateResultRequest(schemaVersion, "updated")
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		boolKeyValue("threadnote.auto_update.repair_required", repairRequired),
	)
	return request
}

func validTelemetryAutoUpdateResultRequest(schemaVersion int64, result string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryRequest()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(schemaVersion)
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("auto-update-worker")
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("threadnote.auto_update.result", result),
	)
	return request
}

func validTelemetryV4CompletionRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryRequest()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(4)
	return request
}

func validTelemetryV4BareGraphOperation(operation string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4CompletionRequest()
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue(operation)
	return request
}

func validTelemetryV4QueryRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4CompletionRequest()
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("inspect_code_graph")
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.phase", "graph.query.execute"),
		stringKeyValue("threadnote.phase.outcome", "success"),
		stringKeyValue("threadnote.graph.request_kind", "inspect.query"),
		stringKeyValue("threadnote.graph.request_scope", "local"),
		stringKeyValue("threadnote.graph.snapshot_selection", "active"),
		stringKeyValue("threadnote.graph.snapshot_freshness", "deferred"),
		stringKeyValue("threadnote.graph.snapshot_files_bucket", "2^10"),
		stringKeyValue("threadnote.graph.snapshot_symbols_bucket", "2^12"),
		stringKeyValue("threadnote.graph.snapshot_edges_bucket", "2^13"),
		&commonpb.KeyValue{Key: "threadnote.phase.elapsed_ms", Value: intAnyValue(1)},
	)
	return request
}

func validTelemetryV4QueryCheckpoint(phase, scope string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	removeSpanAttribute(request, "threadnote.phase")
	removeSpanAttribute(request, "threadnote.phase.outcome")
	removeSpanAttribute(request, "threadnote.phase.elapsed_ms")
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("threadnote.phase", phase),
		stringKeyValue("threadnote.phase.outcome", "success"),
		&commonpb.KeyValue{Key: "threadnote.phase.elapsed_ms", Value: intAnyValue(1)},
	)
	spanAttribute(request, "threadnote.graph.request_scope").Value = stringAnyValue(scope)
	if phase == "graph.query.status" || scope == "workset" {
		removeGraphQuerySnapshotSurface(request)
	}
	return request
}

func validTelemetryV4QueryLivenessCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	for _, key := range []string{
		"threadnote.duration_ms",
		"threadnote.outcome",
		"threadnote.phase",
		"threadnote.phase.outcome",
		"threadnote.phase.elapsed_ms",
	} {
		removeSpanAttribute(request, key)
	}
	removeGraphQuerySnapshotSurface(request)
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		&commonpb.KeyValue{Key: "threadnote.operation.elapsed_ms", Value: intAnyValue(30_000)},
	)
	return request
}

func validTelemetryV4QueryStageCheckpoint(stage string, subphase ...string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryCheckpoint("graph.query.execute", "local")
	removeGraphQuerySnapshotSurface(request)
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("threadnote.stage", stage),
	)
	if len(subphase) == 1 {
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
			stringKeyValue("threadnote.subphase", subphase[0]),
		)
	}
	return request
}

func validTelemetryV4AnalyzeStageCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryStageCheckpoint("query-serialization")
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("analyze_code_graph")
	spanAttribute(request, "threadnote.graph.request_kind").Value = stringAnyValue("analyze.stats")
	return request
}

func validTelemetryV4WorksetStageCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryStageCheckpoint("query-serialization")
	spanAttribute(request, "threadnote.graph.request_scope").Value = stringAnyValue("workset")
	return request
}

func validTelemetryV4FailedFallbackStageCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryStageCheckpoint("query-worktree-observation", "fallback")
	spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
	spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("error.type", "UnknownError"),
	)
	return request
}

func validTelemetryV4NoPublishedSnapshotRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.graph.snapshot_selection").Value = stringAnyValue("none")
	removeSpanAttribute(request, "threadnote.graph.snapshot_freshness")
	for _, key := range graphQuerySnapshotBucketAttributes {
		removeSpanAttribute(request, key)
	}
	return request
}

func validTelemetryV4AnalyzeRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("analyze_code_graph")
	spanAttribute(request, "threadnote.graph.request_kind").Value = stringAnyValue("analyze.stats")
	return request
}

func validTelemetryV4WorksetRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.graph.request_scope").Value = stringAnyValue("workset")
	removeGraphQuerySnapshotSurface(request)
	return request
}

func validTelemetryV4WorksetTopologyRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4WorksetRequest()
	spanAttribute(request, "threadnote.graph.request_kind").Value = stringAnyValue("inspect.topology")
	return request
}

func validTelemetryV4FailedQueryRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryRequest()
	spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
	spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
	removeGraphQuerySnapshotSurface(request)
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("error.type", "UnknownError"),
	)
	return request
}

func validTelemetryV4FailedQueryCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV4QueryCheckpoint("graph.query.execute", "local")
	spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
	spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
	removeGraphQuerySnapshotSurface(request)
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("error.type", "UnknownError"),
	)
	return request
}

func validTelemetryV5ContextBriefRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryRequest()
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(5)
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue("context_brief")
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.phase", "context.brief.projection"),
		stringKeyValue("threadnote.phase.outcome", "success"),
		&commonpb.KeyValue{Key: "threadnote.phase.elapsed_ms", Value: intAnyValue(1)},
		stringKeyValue("threadnote.context_brief.scope", "workset"),
		stringKeyValue("threadnote.context_brief.citation_coverage", "partial"),
		stringKeyValue("threadnote.context_brief.citation_result", "mixed"),
		stringKeyValue("threadnote.context_brief.citation_unknown_reason", "mixed"),
		stringKeyValue("threadnote.context_brief.cache_hits_bucket", "2^2"),
		stringKeyValue("threadnote.context_brief.citations_bucket", "2^3"),
		stringKeyValue("threadnote.context_brief.cited_memories_bucket", "2^2"),
		stringKeyValue("threadnote.context_brief.exact_citations_bucket", "2^2"),
		stringKeyValue("threadnote.context_brief.relocated_citations_bucket", "2^1"),
		stringKeyValue("threadnote.context_brief.repositories_validated_bucket", "2^1"),
		stringKeyValue("threadnote.context_brief.stale_citations_bucket", "2^0"),
		stringKeyValue("threadnote.context_brief.unknown_citations_bucket", "2^0"),
		boolKeyValue("threadnote.context_brief.output_truncated", false),
	)
	return request
}

func validTelemetryV5ContextBriefCheckpoint(phase string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV5ContextBriefRequest()
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	spanAttribute(request, "threadnote.phase").Value = stringAnyValue(phase)
	switch phase {
	case "context.brief.citation-validation":
		removeSpanAttribute(request, "threadnote.context_brief.output_truncated")
	case "context.brief.projection":
		removeContextBriefCitationSurface(request)
	default:
		removeContextBriefCitationSurface(request)
		removeSpanAttribute(request, "threadnote.context_brief.output_truncated")
	}
	return request
}

func validTelemetryV5ContextBriefLivenessCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV5ContextBriefRequest()
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	for _, key := range []string{
		"threadnote.duration_ms",
		"threadnote.outcome",
		"threadnote.phase",
		"threadnote.phase.outcome",
		"threadnote.phase.elapsed_ms",
		"threadnote.context_brief.output_truncated",
	} {
		removeSpanAttribute(request, key)
	}
	removeContextBriefCitationSurface(request)
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		&commonpb.KeyValue{Key: "threadnote.operation.elapsed_ms", Value: intAnyValue(30_000)},
	)
	return request
}

func validTelemetryV5FailedContextBriefRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV5ContextBriefRequest()
	spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
	spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
	removeContextBriefCitationSurface(request)
	removeSpanAttribute(request, "threadnote.context_brief.output_truncated")
	request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("error.type", "UnknownError"),
	)
	return request
}

func removeContextBriefCitationSurface(request *collectortracepb.ExportTraceServiceRequest) {
	for _, key := range append([]string{
		"threadnote.context_brief.citation_coverage",
		"threadnote.context_brief.citation_result",
		"threadnote.context_brief.citation_unknown_reason",
	}, contextBriefCitationBucketAttributes...) {
		removeSpanAttribute(request, key)
	}
}

func validTelemetryV6AnchoredContextBriefRequest() *collectortracepb.ExportTraceServiceRequest {
	request := telemetryRequestWithSchema(validTelemetryV5ContextBriefRequest(), 6)
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.context_brief.contract", "code-anchored-v3"),
		stringKeyValue("threadnote.context_brief.mode", "impact"),
		stringKeyValue("threadnote.context_brief.code_anchor_coverage", "partial"),
		boolKeyValue("threadnote.context_brief.code_anchor_gap", true),
		stringKeyValue("threadnote.context_brief.code_anchors_matched_memories_bucket", "2^3"),
		stringKeyValue("threadnote.context_brief.code_anchors_requested_bucket", "2^2"),
		stringKeyValue("threadnote.context_brief.code_anchors_resolved_bucket", "2^1"),
		stringKeyValue("threadnote.context_brief.gap_class", "unresolved"),
		boolKeyValue("threadnote.context_brief.recovery_present", true),
		stringKeyValue("threadnote.context_brief.returned_lane", "mixed"),
	)
	return request
}

func validTelemetryV6TaskOnlyContextBriefRequest() *collectortracepb.ExportTraceServiceRequest {
	request := telemetryRequestWithSchema(validTelemetryV5ContextBriefRequest(), 6)
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.context_brief.contract", "task-only-v2"),
		stringKeyValue("threadnote.context_brief.mode", "brief"),
		stringKeyValue("threadnote.context_brief.returned_lane", "memory"),
	)
	return request
}

func validTelemetryV6CompleteAnchorsRecallUnavailableRequest() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV6AnchoredContextBriefRequest()
	spanAttribute(request, "threadnote.context_brief.code_anchor_coverage").Value = stringAnyValue("complete")
	spanAttribute(request, "threadnote.context_brief.code_anchors_resolved_bucket").Value = stringAnyValue("2^2")
	spanAttribute(request, "threadnote.context_brief.gap_class").Value = stringAnyValue("unavailable")
	return request
}

func removeContextBriefV6ProjectionSurface(request *collectortracepb.ExportTraceServiceRequest) {
	for _, key := range append([]string{
		"threadnote.context_brief.code_anchor_coverage",
		"threadnote.context_brief.code_anchor_gap",
		"threadnote.context_brief.gap_class",
		"threadnote.context_brief.output_truncated",
		"threadnote.context_brief.recovery_present",
		"threadnote.context_brief.returned_lane",
	}, contextBriefCodeAnchorBucketAttributes...) {
		removeSpanAttribute(request, key)
	}
}

func validTelemetryV6ContextBriefCheckpoint(phase string) *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV6AnchoredContextBriefRequest()
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	spanAttribute(request, "threadnote.phase").Value = stringAnyValue(phase)
	switch phase {
	case "context.brief.citation-validation":
		removeContextBriefV6ProjectionSurface(request)
	case "context.brief.projection":
		removeContextBriefCitationSurface(request)
	default:
		removeContextBriefCitationSurface(request)
		removeContextBriefV6ProjectionSurface(request)
	}
	return request
}

func validTelemetryV6FinalizationCheckpoint(trigger string) *collectortracepb.ExportTraceServiceRequest {
	request := telemetryRequestWithSchema(validTelemetryRequest(), 6)
	operation := "graph.index"
	if trigger == "explicit" {
		operation = "finalize_code_refs"
	}
	spanAttribute(request, "threadnote.operation").Value = stringAnyValue(operation)
	spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	span.Attributes = append(span.Attributes,
		stringKeyValue("threadnote.phase", "memory.code-anchor-finalization"),
		stringKeyValue("threadnote.phase.outcome", "success"),
		&commonpb.KeyValue{Key: "threadnote.phase.elapsed_ms", Value: intAnyValue(12)},
		stringKeyValue("threadnote.code_anchor_finalization.trigger", trigger),
		stringKeyValue("threadnote.code_anchor_finalization.result", "finalized"),
		stringKeyValue("threadnote.code_anchor_finalization.conflict_bucket", "0"),
		stringKeyValue("threadnote.code_anchor_finalization.failed_bucket", "0"),
		stringKeyValue("threadnote.code_anchor_finalization.finalized_bucket", "2^1"),
		stringKeyValue("threadnote.code_anchor_finalization.latency_ms_bucket", "2^3"),
		stringKeyValue("threadnote.code_anchor_finalization.pending_bucket", "0"),
		stringKeyValue("threadnote.code_anchor_finalization.scanned_bucket", "2^1"),
	)
	if trigger != "explicit" {
		span.Attributes = append(span.Attributes, stringKeyValue("threadnote.code_anchor_finalization.matched_bucket", "2^1"))
	}
	return request
}

func validTelemetryV6FailedBeforeScanFinalizationCheckpoint() *collectortracepb.ExportTraceServiceRequest {
	request := validTelemetryV6FinalizationCheckpoint("graph-index")
	spanAttribute(request, "threadnote.code_anchor_finalization.result").Value = stringAnyValue("failed")
	for _, key := range []string{
		"threadnote.code_anchor_finalization.conflict_bucket",
		"threadnote.code_anchor_finalization.failed_bucket",
		"threadnote.code_anchor_finalization.finalized_bucket",
		"threadnote.code_anchor_finalization.pending_bucket",
		"threadnote.code_anchor_finalization.scanned_bucket",
	} {
		spanAttribute(request, key).Value = stringAnyValue("0")
	}
	spanAttribute(request, "threadnote.code_anchor_finalization.matched_bucket").Value = stringAnyValue("0")
	return request
}

func TestCanonicalTelemetryPayloadAcceptsFrozenV1ThroughV5AndClosedV6(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []*collectortracepb.ExportTraceServiceRequest{
		validTelemetryRequest(),
		validTelemetryV2CompletionRequest(),
		validTelemetryV2Request(),
		validTelemetryV3GraphRequest(),
		validTelemetryAutoUpdateRequest(3, false),
		validTelemetryAutoUpdateRequest(3, true),
		validTelemetryV4CompletionRequest(),
		validTelemetryAutoUpdateRequest(4, false),
		validTelemetryAutoUpdateRequest(4, true),
		validTelemetryV4BareGraphOperation("inspect_code_graph"),
		validTelemetryV4BareGraphOperation("analyze_code_graph"),
		validTelemetryV4QueryRequest(),
		validTelemetryV4NoPublishedSnapshotRequest(),
		validTelemetryV4AnalyzeRequest(),
		validTelemetryV4WorksetRequest(),
		validTelemetryV4WorksetTopologyRequest(),
		validTelemetryV4FailedQueryRequest(),
		validTelemetryV4FailedQueryCheckpoint(),
		validTelemetryV4QueryLivenessCheckpoint(),
		validTelemetryV4QueryStageCheckpoint("query-repository-identity"),
		validTelemetryV4QueryStageCheckpoint("query-worktree-observation", "skipped"),
		validTelemetryV4QueryStageCheckpoint("query-strict-reobservation"),
		validTelemetryV4QueryStageCheckpoint("query-serialization", "fallback"),
		validTelemetryV4AnalyzeStageCheckpoint(),
		validTelemetryV4WorksetStageCheckpoint(),
		validTelemetryV4FailedFallbackStageCheckpoint(),
		validTelemetryV4QueryCheckpoint("graph.query.status", "local"),
		validTelemetryV4QueryCheckpoint("graph.query.snapshot", "local"),
		validTelemetryV4QueryCheckpoint("graph.query.execute", "local"),
		validTelemetryV4QueryCheckpoint("graph.query.execute", "workset"),
		telemetryRequestWithSchema(validTelemetryV2Request(), 5),
		validTelemetryAutoUpdateRequest(5, false),
		telemetryRequestWithSchema(validTelemetryV4QueryRequest(), 5),
		validTelemetryV5ContextBriefRequest(),
		validTelemetryV5ContextBriefCheckpoint("context.brief.graph"),
		validTelemetryV5ContextBriefCheckpoint("context.brief.memory"),
		validTelemetryV5ContextBriefCheckpoint("context.brief.citation-validation"),
		validTelemetryV5ContextBriefCheckpoint("context.brief.projection"),
		validTelemetryV5ContextBriefLivenessCheckpoint(),
		validTelemetryV5FailedContextBriefRequest(),
		telemetryRequestWithSchema(validTelemetryV2Request(), 6),
		telemetryRequestWithSchema(validTelemetryV4QueryRequest(), 6),
		validTelemetryV6TaskOnlyContextBriefRequest(),
		validTelemetryV6AnchoredContextBriefRequest(),
		validTelemetryV6CompleteAnchorsRecallUnavailableRequest(),
		validTelemetryV6ContextBriefCheckpoint("context.brief.graph"),
		validTelemetryV6ContextBriefCheckpoint("context.brief.memory"),
		validTelemetryV6ContextBriefCheckpoint("context.brief.code-linked-memory"),
		validTelemetryV6ContextBriefCheckpoint("context.brief.citation-validation"),
		validTelemetryV6ContextBriefCheckpoint("context.brief.projection"),
		validTelemetryV6FinalizationCheckpoint("explicit"),
		validTelemetryV6FinalizationCheckpoint("graph-index"),
		validTelemetryV6FailedBeforeScanFinalizationCheckpoint(),
	} {
		payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
		if marshalError != nil {
			t.Fatal(marshalError)
		}
		canonical, validationError := canonicalTelemetryPayload(payload, schemas)
		if validationError != nil {
			t.Fatalf("valid schema version was rejected: %v", validationError)
		}
		if !bytes.Equal(canonical, payload) {
			t.Fatal("valid canonical telemetry was changed")
		}
	}
	for _, schemaVersion := range []int64{3, 4, 5, 6} {
		for _, result := range []string{"busy", "current", "disabled", "failed"} {
			request := validTelemetryAutoUpdateResultRequest(schemaVersion, result)
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError != nil {
				t.Fatalf("valid v%d automatic update result %q was rejected: %v", schemaVersion, result, validationError)
			}
		}
	}
	for _, errorType := range []string{"CommandCleanupUnconfirmed", "ContextBriefNativeReadFailed", "ReadDeadlineExceeded", "RecallReadyReadBoundaryError", "UnknownError"} {
		for _, version := range []int64{1, 2, 3, 4, 5, 6} {
			request := telemetryRequestWithSchema(validTelemetryRequest(), version)
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes, stringKeyValue("error.type", errorType))
			if errorType == "UnknownError" {
				span.Attributes = append(span.Attributes, stringKeyValue("threadnote.failure.domain", "model-worker"), stringKeyValue("threadnote.failure.operation", "embed-many"), stringKeyValue("threadnote.failure.reason", "cleanup-unconfirmed"))
			}
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			_, validationError := canonicalTelemetryPayload(payload, schemas)
			if (validationError == nil) != (version == 6) {
				t.Fatalf("v%d error %s validation = %v", version, errorType, validationError)
			}
		}
	}
}

func telemetryRequestWithSchema(request *collectortracepb.ExportTraceServiceRequest, schemaVersion int64) *collectortracepb.ExportTraceServiceRequest {
	resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(schemaVersion)
	return request
}

func TestCanonicalTelemetryPayloadAcceptsEveryClosedV5ContextBriefResult(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		coverage string
		result   string
		buckets  map[string]string
		reason   string
	}{
		{coverage: "none", result: "none", buckets: map[string]string{
			"threadnote.context_brief.cache_hits_bucket": "0", "threadnote.context_brief.citations_bucket": "0",
			"threadnote.context_brief.cited_memories_bucket": "0", "threadnote.context_brief.exact_citations_bucket": "0",
			"threadnote.context_brief.relocated_citations_bucket": "0", "threadnote.context_brief.repositories_validated_bucket": "0",
			"threadnote.context_brief.stale_citations_bucket": "0", "threadnote.context_brief.unknown_citations_bucket": "0",
		}},
		{coverage: "complete", result: "exact-only", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "2^3", "threadnote.context_brief.relocated_citations_bucket": "0",
			"threadnote.context_brief.stale_citations_bucket": "0", "threadnote.context_brief.unknown_citations_bucket": "0",
		}},
		{coverage: "complete", result: "relocated", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "2^2", "threadnote.context_brief.relocated_citations_bucket": "2^2",
			"threadnote.context_brief.stale_citations_bucket": "0", "threadnote.context_brief.unknown_citations_bucket": "0",
		}},
		{coverage: "complete", result: "stale", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "2^2", "threadnote.context_brief.relocated_citations_bucket": "2^1",
			"threadnote.context_brief.stale_citations_bucket": "2^1", "threadnote.context_brief.unknown_citations_bucket": "0",
		}},
		{coverage: "partial", result: "unknown", reason: "unsupported", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "2^2", "threadnote.context_brief.relocated_citations_bucket": "2^1",
			"threadnote.context_brief.stale_citations_bucket": "0", "threadnote.context_brief.unknown_citations_bucket": "2^1",
		}},
		{coverage: "partial", result: "mixed", reason: "mixed", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "2^2", "threadnote.context_brief.relocated_citations_bucket": "2^1",
			"threadnote.context_brief.stale_citations_bucket": "2^0", "threadnote.context_brief.unknown_citations_bucket": "2^0",
		}},
		{coverage: "unavailable", result: "unknown", reason: "snapshot-unavailable", buckets: map[string]string{
			"threadnote.context_brief.exact_citations_bucket": "0", "threadnote.context_brief.relocated_citations_bucket": "0",
			"threadnote.context_brief.stale_citations_bucket": "0", "threadnote.context_brief.unknown_citations_bucket": "2^3",
		}},
	}
	for _, test := range tests {
		t.Run(test.coverage+"/"+test.result, func(t *testing.T) {
			request := validTelemetryV5ContextBriefRequest()
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue(test.coverage)
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue(test.result)
			for key, value := range test.buckets {
				spanAttribute(request, key).Value = stringAnyValue(value)
			}
			if test.reason == "" {
				removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
			} else {
				spanAttribute(request, "threadnote.context_brief.citation_unknown_reason").Value = stringAnyValue(test.reason)
			}
			removeSpanAttribute(request, "threadnote.phase.outcome")
			removeSpanAttribute(request, "threadnote.phase.elapsed_ms")
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError != nil {
				t.Fatalf("valid Context Brief result was rejected: %v", validationError)
			}
		})
	}
}

func TestFrozenTelemetrySchemaArtifactsRemainByteForByte(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		data   []byte
		digest string
	}{
		{name: "v1", data: telemetrySchemaV1JSON, digest: "68ebd9161b68f18267fc7692250bcae1d9ff7dddd5394271304b60e4035d9ef0"},
		{name: "v2", data: telemetrySchemaV2JSON, digest: "584061cf487c7fcef250d7ffa1ffaff96cbd0c8bd76da3d33d084f95cfcb68dd"},
		{name: "v3", data: telemetrySchemaV3JSON, digest: "595f5d2f30fb58d4804b4b42dc2c2e81c84f57f53412ebcf3dbd6c052ed36217"},
		{name: "v4", data: telemetrySchemaV4JSON, digest: "2753788350ad94da58fe265e904be54bc670ef2bed962a25fffedc238b479d5c"},
		{name: "v5", data: telemetrySchemaV5JSON, digest: "12b359d02303dfcfe3c679000988a35028d1689ea92e725a73288eb3560a1b6e"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			digest := sha256.Sum256(fixture.data)
			if hex.EncodeToString(digest[:]) != fixture.digest {
				t.Fatal("frozen telemetry schema artifact changed")
			}
		})
	}
}

func TestV3ThroughV5RetainTheCompleteTerminalGraphBuildContract(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	for _, schemaVersion := range []int64{3, 4, 5} {
		request := validTelemetryV2Request()
		resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(schemaVersion)
		payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
		if marshalError != nil {
			t.Fatal(marshalError)
		}
		if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError != nil {
			t.Fatalf("schema v%d graph build lifecycle was rejected: %v", schemaVersion, validationError)
		}
	}
}

func TestCanonicalTelemetryPayloadRejectsSchemaMixingAndInvalidV2Shapes(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "mixed resource schema versions", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			v1 := validTelemetryRequest().ResourceSpans[0]
			request.ResourceSpans = append(request.ResourceSpans, v1)
		}},
		{name: "v2 attribute under v1 resource", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(1)
		}},
		{name: "unknown schema version", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(7)
		}},
		{name: "wrong schema version type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = stringAnyValue("2")
		}},
		{name: "unknown graph classification", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.efficiency_class").Value = stringAnyValue("private-repository")
		}},
		{name: "wrong graph classification type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.build_kind").Value = intAnyValue(1)
		}},
		{name: "wrong graph bucket type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.changed_files_bucket").Value = intAnyValue(2)
		}},
		{name: "out of range graph bucket", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.changed_files_bucket").Value = stringAnyValue("2^53")
		}},
		{name: "incomplete success surface", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.total_files_bucket")
		}},
		{name: "graph attributes outside lifecycle", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.event").Value = stringAnyValue("completion")
		}},
		{name: "partial graph attributes on failure", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("error.type", "UnknownError"),
			)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validTelemetryV2Request()
			test.mutate(request)
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("invalid or mixed telemetry schema was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsInvalidV3ThroughV5AutoUpdateShapes(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "unknown result", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.auto_update.result").Value = stringAnyValue("private-installation")
		}},
		{name: "wrong result type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.auto_update.result").Value = intAnyValue(1)
		}},
		{name: "repair flag without updated result", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.auto_update.result").Value = stringAnyValue("failed")
		}},
		{name: "updated result without repair flag", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.auto_update.repair_required")
		}},
		{name: "automatic update attributes under v2", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(2)
		}},
		{name: "automatic update attributes on another operation", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("update")
		}},
		{name: "successful worker completion without result", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.auto_update.result")
			removeSpanAttribute(request, "threadnote.auto_update.repair_required")
		}},
	}
	for _, schemaVersion := range []int64{3, 4, 5} {
		for _, test := range tests {
			t.Run(fmt.Sprintf("v%d/%s", schemaVersion, test.name), func(t *testing.T) {
				request := validTelemetryAutoUpdateRequest(schemaVersion, false)
				test.mutate(request)
				payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
				if marshalError != nil {
					t.Fatal(marshalError)
				}
				if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
					t.Fatal("invalid automatic update telemetry was accepted")
				}
			})
		}
	}
}

func TestCanonicalTelemetryPayloadRejectsInvalidV4GraphQueryShapes(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		request func() *collectortracepb.ExportTraceServiceRequest
		mutate  func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "v4 surface under v1", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(1)
		}},
		{name: "v4 surface under v2", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(2)
		}},
		{name: "v4 surface under v3", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(3)
		}},
		{name: "missing request kind", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.request_kind")
		}},
		{name: "missing request scope", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.request_scope")
		}},
		{name: "inspect operation with analyze kind", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.request_kind").Value = stringAnyValue("analyze.stats")
		}},
		{name: "analyze operation with inspect kind", request: validTelemetryV4AnalyzeRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.request_kind").Value = stringAnyValue("inspect.query")
		}},
		{name: "query attributes on generic operation", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("health")
		}},
		{name: "lifecycle query event", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.event").Value = stringAnyValue("lifecycle")
		}},
		{name: "completion with status phase", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("graph.query.status")
		}},
		{name: "completion with snapshot phase", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("graph.query.snapshot")
		}},
		{name: "checkpoint without query phase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryCheckpoint("graph.query.status", "local")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.phase")
		}},
		{name: "phase-less query checkpoint without operation elapsed time", request: validTelemetryV4QueryLivenessCheckpoint, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.operation.elapsed_ms")
		}},
		{name: "phase-less query checkpoint with snapshot surface", request: validTelemetryV4QueryLivenessCheckpoint, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.graph.snapshot_selection", "none"),
			)
		}},
		{name: "query stage on completion", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-serialization")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.event").Value = stringAnyValue("completion")
		}},
		{name: "query stage on lifecycle", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-serialization")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.event").Value = stringAnyValue("lifecycle")
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("error.type", "UnknownError"),
			)
		}},
		{name: "query stage on generic operation", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-repository-identity")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("health")
		}},
		{name: "query stage with snapshot surface", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-worktree-observation")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.graph.snapshot_selection", "none"),
			)
		}},
		{name: "query stage without elapsed time", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-strict-reobservation")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.phase.elapsed_ms")
		}},
		{name: "query stage without query phase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-repository-identity")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.phase")
		}},
		{name: "query stage with non-query phase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-repository-identity")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("graph.activating")
		}},
		{name: "query stage without phase outcome", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-serialization")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.phase.outcome")
		}},
		{name: "query stage with disagreeing outcomes", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-repository-identity")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
		}},
		{name: "skipped query stage with failure outcome", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-worktree-observation", "skipped")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
			spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("error.type", "UnknownError"),
			)
		}},
		{name: "query subphase without query stage", request: validTelemetryV4QueryLivenessCheckpoint, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.subphase", "skipped"),
			)
		}},
		{name: "query stage with generic subphase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryStageCheckpoint("query-serialization", "complete")
		}, mutate: func(_ *collectortracepb.ExportTraceServiceRequest) {}},
		{name: "query subphase on generic stage", request: validTelemetryV4CompletionRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.event").Value = stringAnyValue("checkpoint")
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.stage", "reading"),
				stringKeyValue("threadnote.subphase", "fallback"),
			)
		}},
		{name: "checkpoint with non-query phase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryCheckpoint("graph.query.status", "local")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("graph.activating")
		}},
		{name: "status checkpoint with snapshot surface", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryCheckpoint("graph.query.snapshot", "local")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("graph.query.status")
		}},
		{name: "local snapshot checkpoint without selection", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV4QueryCheckpoint("graph.query.snapshot", "local")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.snapshot_selection")
		}},
		{name: "workset completion with local snapshot surface", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.request_scope").Value = stringAnyValue("workset")
		}},
		{name: "selected snapshot without edge bucket", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.snapshot_edges_bucket")
		}},
		{name: "selected snapshot without freshness", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.graph.snapshot_freshness")
		}},
		{name: "selection none with published snapshot buckets", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.graph.snapshot_selection").Value = stringAnyValue("none")
		}},
		{name: "selection none with freshness", request: validTelemetryV4NoPublishedSnapshotRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes, stringKeyValue("threadnote.graph.snapshot_freshness", "stale"))
		}},
		{name: "failed completion with snapshot surface", request: validTelemetryV4QueryRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue("failure")
			spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("error.type", "UnknownError"),
			)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := test.request()
			test.mutate(request)
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("invalid schema v4 graph query telemetry was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsArbitraryPrivateV4GraphQueryClassifications(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		private := "private-" + hex.EncodeToString(digest[:])
		for _, key := range []string{
			"threadnote.graph.request_kind",
			"threadnote.graph.request_scope",
			"threadnote.graph.snapshot_freshness",
			"threadnote.graph.snapshot_selection",
			"threadnote.stage",
			"threadnote.subphase",
		} {
			request := validTelemetryV4QueryRequest()
			if key == "threadnote.stage" || key == "threadnote.subphase" {
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
					request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
					stringKeyValue(key, private),
				)
			} else {
				spanAttribute(request, key).Value = stringAnyValue(private)
			}
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				return false
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				return false
			}
		}
		return true
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func TestSchemaV4RejectsEveryV5OnlyContextBriefField(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	for _, keyValue := range validTelemetryV5ContextBriefRequest().ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes {
		if keyValue == nil || !strings.HasPrefix(keyValue.Key, "threadnote.context_brief.") {
			continue
		}
		t.Run(keyValue.Key, func(t *testing.T) {
			request := validTelemetryV4CompletionRequest()
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				proto.Clone(keyValue).(*commonpb.KeyValue),
			)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("schema v4 accepted a v5-only Context Brief field")
			}
		})
	}
	for _, phase := range []string{
		"context.brief.graph",
		"context.brief.memory",
		"context.brief.citation-validation",
		"context.brief.projection",
	} {
		t.Run(phase, func(t *testing.T) {
			request := validTelemetryV4CompletionRequest()
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes,
				stringKeyValue("threadnote.phase", phase),
				stringKeyValue("threadnote.phase.outcome", "success"),
				&commonpb.KeyValue{Key: "threadnote.phase.elapsed_ms", Value: intAnyValue(1)},
			)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("schema v4 accepted a v5-only Context Brief phase")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsInvalidV5ContextBriefShapes(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		request func() *collectortracepb.ExportTraceServiceRequest
		mutate  func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "v5 surface under v4", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			resourceAttribute(request, "threadnote.telemetry.schema_version").Value = intAnyValue(4)
		}},
		{name: "missing scope", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.context_brief.scope")
		}},
		{name: "wrong scope type", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.scope").Value = intAnyValue(1)
		}},
		{name: "unknown coverage", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("private-coverage")
		}},
		{name: "unknown result", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("private-result")
		}},
		{name: "unknown reason", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_unknown_reason").Value = stringAnyValue("private-reason")
		}},
		{name: "exact result with unknown reason", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("exact-only")
		}},
		{name: "unknown result without reason", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("unknown")
			removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
		}},
		{name: "missing citation bucket", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.context_brief.cache_hits_bucket")
		}},
		{name: "wrong citation bucket type", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citations_bucket").Value = intAnyValue(8)
		}},
		{name: "out of range citation bucket", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citations_bucket").Value = stringAnyValue("2^53")
		}},
		{name: "wrong truncation type", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.output_truncated").Value = stringAnyValue("false")
		}},
		{name: "completion without truncation", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.context_brief.output_truncated")
		}},
		{name: "completion with non-projection phase", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase").Value = stringAnyValue("context.brief.citation-validation")
		}},
		{name: "none coverage with citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("none")
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("none")
			removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
		}},
		{name: "none result with nonempty complete coverage", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("complete")
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("none")
			removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
			spanAttribute(request, "threadnote.context_brief.unknown_citations_bucket").Value = stringAnyValue("0")
		}},
		{name: "complete coverage with unknown citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("complete")
		}},
		{name: "partial coverage without known citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			for _, key := range []string{"threadnote.context_brief.exact_citations_bucket", "threadnote.context_brief.relocated_citations_bucket", "threadnote.context_brief.stale_citations_bucket"} {
				spanAttribute(request, key).Value = stringAnyValue("0")
			}
		}},
		{name: "unavailable coverage with exact citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("unavailable")
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("unknown")
		}},
		{name: "exact-only result with relocated citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("complete")
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("exact-only")
			removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
			spanAttribute(request, "threadnote.context_brief.stale_citations_bucket").Value = stringAnyValue("0")
			spanAttribute(request, "threadnote.context_brief.unknown_citations_bucket").Value = stringAnyValue("0")
		}},
		{name: "relocated result without relocated citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.citation_coverage").Value = stringAnyValue("complete")
			spanAttribute(request, "threadnote.context_brief.citation_result").Value = stringAnyValue("relocated")
			removeSpanAttribute(request, "threadnote.context_brief.citation_unknown_reason")
			spanAttribute(request, "threadnote.context_brief.relocated_citations_bucket").Value = stringAnyValue("0")
			spanAttribute(request, "threadnote.context_brief.stale_citations_bucket").Value = stringAnyValue("0")
			spanAttribute(request, "threadnote.context_brief.unknown_citations_bucket").Value = stringAnyValue("0")
		}},
		{name: "status bucket larger than citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.exact_citations_bucket").Value = stringAnyValue("2^4")
		}},
		{name: "cache bucket larger than citations", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.cache_hits_bucket").Value = stringAnyValue("2^4")
		}},
		{name: "context fields on another operation", request: validTelemetryV5ContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("health")
		}},
		{name: "citation checkpoint with truncation", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV5ContextBriefCheckpoint("context.brief.citation-validation")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				boolKeyValue("threadnote.context_brief.output_truncated", false),
			)
		}},
		{name: "projection checkpoint with citation result", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV5ContextBriefCheckpoint("context.brief.projection")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.context_brief.citation_coverage", "complete"),
			)
		}},
		{name: "graph checkpoint with result", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV5ContextBriefCheckpoint("context.brief.graph")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.context_brief.citation_result", "none"),
			)
		}},
		{name: "failed completion with result", request: validTelemetryV5FailedContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.context_brief.citation_coverage", "unavailable"),
			)
		}},
		{name: "liveness checkpoint without elapsed time", request: validTelemetryV5ContextBriefLivenessCheckpoint, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.operation.elapsed_ms")
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := test.request()
			test.mutate(request)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("invalid schema v5 Context Brief telemetry was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsArbitraryPrivateV5ContextBriefClassifications(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		private := "private-" + hex.EncodeToString(digest[:])
		for _, key := range []string{
			"threadnote.context_brief.scope",
			"threadnote.context_brief.citation_coverage",
			"threadnote.context_brief.citation_result",
			"threadnote.context_brief.citation_unknown_reason",
		} {
			request := validTelemetryV5ContextBriefRequest()
			spanAttribute(request, key).Value = stringAnyValue(private)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				return false
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				return false
			}
		}
		return true
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func TestCanonicalTelemetryPayloadRejectsInvalidV6ContextBriefAndFinalizationShapes(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		request func() *collectortracepb.ExportTraceServiceRequest
		mutate  func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "task-only with anchor results", request: validTelemetryV6TaskOnlyContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.context_brief.code_anchor_coverage", "complete"),
			)
		}},
		{name: "anchored projection missing gap class", request: validTelemetryV6AnchoredContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.context_brief.gap_class")
		}},
		{name: "gap class inconsistent with gap boolean", request: validTelemetryV6AnchoredContextBriefRequest, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.gap_class").Value = stringAnyValue("none")
		}},
		{name: "task-only code-linked-memory phase", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6ContextBriefCheckpoint("context.brief.code-linked-memory")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.context_brief.contract").Value = stringAnyValue("task-only-v2")
		}},
		{name: "projection checkpoint carries citation result", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6ContextBriefCheckpoint("context.brief.projection")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.context_brief.citation_coverage", "complete"),
			)
		}},
		{name: "explicit operation with automatic trigger", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.code_anchor_finalization.trigger").Value = stringAnyValue("graph-index")
		}},
		{name: "missing finalization bucket", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.code_anchor_finalization.pending_bucket")
		}},
		{name: "automatic finalization without matched bucket", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("graph-index")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			removeSpanAttribute(request, "threadnote.code_anchor_finalization.matched_bucket")
		}},
		{name: "explicit finalization with matched bucket", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
				stringKeyValue("threadnote.code_anchor_finalization.matched_bucket", "2^1"),
			)
		}},
		{name: "finalization result inconsistent with buckets", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.code_anchor_finalization.result").Value = stringAnyValue("pending")
		}},
		{name: "explicit finalization reports contention", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.code_anchor_finalization.result").Value = stringAnyValue("contended")
		}},
		{name: "explicit finalization fails before scanning", request: validTelemetryV6FailedBeforeScanFinalizationCheckpoint, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.code_anchor_finalization.trigger").Value = stringAnyValue("explicit")
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("finalize_code_refs")
			removeSpanAttribute(request, "threadnote.code_anchor_finalization.matched_bucket")
		}},
		{name: "failed phase carries successful result", request: func() *collectortracepb.ExportTraceServiceRequest {
			return validTelemetryV6FinalizationCheckpoint("explicit")
		}, mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.phase.outcome").Value = stringAnyValue("failure")
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := test.request()
			test.mutate(request)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("invalid schema v6 telemetry was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsArbitraryPrivateV6Classifications(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		private := "private-" + hex.EncodeToString(digest[:])
		for _, key := range []string{
			"error.type",
			"threadnote.failure.reason",
			"threadnote.context_brief.code_anchor_coverage",
			"threadnote.context_brief.contract",
			"threadnote.context_brief.gap_class",
			"threadnote.context_brief.mode",
			"threadnote.context_brief.returned_lane",
		} {
			request := validTelemetryV6AnchoredContextBriefRequest()
			if key == "error.type" || key == "threadnote.failure.reason" {
				request = telemetryRequestWithSchema(validTelemetryV4FailedQueryRequest(), 6)
				if key == "threadnote.failure.reason" {
					span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
					span.Attributes = append(span.Attributes, stringKeyValue("threadnote.failure.domain", "model-worker"), stringKeyValue("threadnote.failure.operation", "embed-many"), stringKeyValue(key, "crash"))
				}
			}
			spanAttribute(request, key).Value = stringAnyValue(private)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				return false
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				return false
			}
		}
		for _, key := range []string{
			"threadnote.code_anchor_finalization.result",
			"threadnote.code_anchor_finalization.trigger",
		} {
			request := validTelemetryV6FinalizationCheckpoint("explicit")
			spanAttribute(request, key).Value = stringAnyValue(private)
			payload, marshalError := proto.Marshal(request)
			if marshalError != nil {
				return false
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				return false
			}
		}
		return true
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func TestCanonicalTelemetryPayloadAllowsBoundedNonSuccessfulV2GraphLifecycle(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []string{"failure", "interrupted"} {
		t.Run(outcome, func(t *testing.T) {
			request := validTelemetryV2Request()
			spanAttribute(request, "threadnote.outcome").Value = stringAnyValue(outcome)
			if outcome == "failure" {
				request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
					request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
					stringKeyValue("error.type", "UnknownError"),
				)
			}
			for _, key := range terminalGraphSpanAttributes {
				removeSpanAttribute(request, key)
			}
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError != nil {
				t.Fatalf("bounded %s graph lifecycle was rejected: %v", outcome, validationError)
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsArbitraryPrivateGraphClassifications(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		request := validTelemetryV2Request()
		spanAttribute(request, "threadnote.graph.fallback_reason").Value = stringAnyValue(
			"private-" + hex.EncodeToString(digest[:]),
		)
		payload, marshalError := proto.Marshal(request)
		if marshalError != nil {
			return false
		}
		_, validationError := canonicalTelemetryPayload(payload, schemas)
		return validationError != nil
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func TestIngressRejectsAdversarialTelemetryAtomically(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	schema := schemas.byVersion[1]
	valid := validTelemetryRequest()
	tests := []struct {
		name   string
		mutate func(*collectortracepb.ExportTraceServiceRequest)
	}{
		{name: "unknown protobuf field", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ProtoReflect().SetUnknown([]byte{0x10, 0x01})
		}},
		{name: "multiple resources", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans = append(request.ResourceSpans, proto.Clone(request.ResourceSpans[0]).(*tracepb.ResourceSpans))
		}},
		{name: "unknown resource attribute", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes = append(request.ResourceSpans[0].Resource.Attributes, stringKeyValue("private.path", "/Users/private"))
		}},
		{name: "invalid sibling span", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			invalid := proto.Clone(request.ResourceSpans[0].ScopeSpans[0].Spans[0]).(*tracepb.Span)
			invalid.TraceId, invalid.SpanId = bytes.Repeat([]byte{3}, 16), bytes.Repeat([]byte{4}, 8)
			invalid.Attributes = append(invalid.Attributes, stringKeyValue("private.path", "/Users/private"))
			request.ResourceSpans[0].ScopeSpans[0].Spans = append(
				request.ResourceSpans[0].ScopeSpans[0].Spans,
				invalid,
			)
		}},
		{name: "wrong resource type", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes[1].Value = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: 42}}
		}},
		{name: "unbounded service version", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].Resource.Attributes[1].Value = stringAnyValue(strings.Repeat("1", schema.Limits.MaxVersionBytes+1))
		}},
		{name: "private operation", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = stringAnyValue("/Users/private/repository")
		}},
		{name: "array value", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			spanAttribute(request, "threadnote.operation").Value = &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{}}}
		}},
		{name: "event", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Events = []*tracepb.Span_Event{{Name: "private"}}
		}},
		{name: "link", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Links = []*tracepb.Span_Link{{TraceId: bytes.Repeat([]byte{3}, 16), SpanId: bytes.Repeat([]byte{4}, 8)}}
		}},
		{name: "status message", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			request.ResourceSpans[0].ScopeSpans[0].Spans[0].Status.Message = "private"
		}},
		{name: "partial memory buckets", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes, stringKeyValue("threadnote.memory.rss.start_bucket", "<32MiB"))
		}},
		{name: "cross-domain operation", mutate: func(request *collectortracepb.ExportTraceServiceRequest) {
			span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
			span.Attributes = append(span.Attributes,
				stringKeyValue("threadnote.failure.domain", "model-worker"),
				stringKeyValue("threadnote.failure.operation", "load-code-graph-adjacency"),
				stringKeyValue("threadnote.failure.reason", "crash"))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := proto.Clone(valid).(*collectortracepb.ExportTraceServiceRequest)
			test.mutate(request)
			payload, marshalError := (proto.MarshalOptions{Deterministic: true}).Marshal(request)
			if marshalError != nil {
				t.Fatal(marshalError)
			}
			if _, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
				t.Fatal("adversarial telemetry was accepted")
			}
		})
	}
}

func TestCanonicalTelemetryPayloadRejectsDuplicateSingularWireFields(t *testing.T) {
	schemas, err := loadTelemetrySchemas()
	if err != nil {
		t.Fatal(err)
	}
	valid := validTelemetryPayload(t)
	request := validTelemetryRequest()
	resourceSpans, marshalError := proto.Marshal(request.ResourceSpans[0])
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateTopLevel := append(append([]byte(nil), valid...), protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), resourceSpans)...)
	if _, validationError := canonicalTelemetryPayload(duplicateTopLevel, schemas); validationError == nil {
		t.Fatal("duplicate top-level resource_spans was accepted")
	}

	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	spanWire, marshalError := proto.Marshal(span)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateName := protowire.AppendBytes(protowire.AppendTag(append([]byte(nil), spanWire...), 5, protowire.BytesType), []byte("threadnote.anonymous-diagnostic"))
	if err := validateWireMessage(duplicateName, wireSpan); err == nil {
		t.Fatal("duplicate span name was accepted")
	}

	attribute := span.Attributes[0]
	attributeWire, marshalError := proto.Marshal(attribute)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	duplicateAttributeKey := protowire.AppendBytes(protowire.AppendTag(append([]byte(nil), attributeWire...), 1, protowire.BytesType), []byte(attribute.Key))
	if err := validateWireMessage(duplicateAttributeKey, wireKeyValue); err == nil {
		t.Fatal("duplicate attribute key was accepted")
	}

	anyValueWire, marshalError := proto.Marshal(attribute.Value)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	multipleOneofValues := protowire.AppendVarint(protowire.AppendTag(append([]byte(nil), anyValueWire...), 2, protowire.VarintType), 1)
	if err := validateWireMessage(multipleOneofValues, wireAnyValue); err == nil {
		t.Fatal("multiple AnyValue oneof fields were accepted")
	}
}

func TestIngressRejectsAdversarialTelemetryWithoutContactingCollector(t *testing.T) {
	listener, listenError := net.Listen("tcp", "127.0.0.1:4318")
	if listenError != nil {
		t.Fatal(listenError)
	}
	requests := make(chan struct{}, 1)
	backend := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		response.WriteHeader(http.StatusOK)
	})}
	go func() { _ = backend.Serve(listener) }()
	t.Cleanup(func() { _ = backend.Close() })

	invalid := validTelemetryRequest()
	invalid.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes = append(
		invalid.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes,
		stringKeyValue("private.path", "/Users/private/repository"),
	)
	payload, marshalError := proto.Marshal(invalid)
	if marshalError != nil {
		t.Fatal(marshalError)
	}
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid request returned %d, want %d", response.Code, http.StatusBadRequest)
	}
	select {
	case <-requests:
		t.Fatal("invalid telemetry reached Collector")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestIngressRejectsArbitraryPrivateOperationValues(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	property := func(value string) bool {
		digest := sha256.Sum256([]byte(value))
		invalid := validTelemetryRequest()
		spanAttribute(invalid, "threadnote.operation").Value = stringAnyValue("private-" + hex.EncodeToString(digest[:]))
		payload, marshalError := proto.Marshal(invalid)
		if marshalError != nil {
			return false
		}
		request := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/x-protobuf")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code == http.StatusBadRequest
	}
	if propertyError := quick.Check(property, &quick.Config{MaxCount: 32}); propertyError != nil {
		t.Fatal(propertyError)
	}
}

func stringAnyValue(value string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
}

func intAnyValue(value int64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: value}}
}

func boolAnyValue(value bool) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: value}}
}

func stringKeyValue(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: key, Value: stringAnyValue(value)}
}

func boolKeyValue(key string, value bool) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: key, Value: boolAnyValue(value)}
}

func spanAttribute(request *collectortracepb.ExportTraceServiceRequest, key string) *commonpb.KeyValue {
	for _, attribute := range request.ResourceSpans[0].ScopeSpans[0].Spans[0].Attributes {
		if attribute.Key == key {
			return attribute
		}
	}
	panic("missing fixture attribute")
}

func resourceAttribute(request *collectortracepb.ExportTraceServiceRequest, key string) *commonpb.KeyValue {
	for _, attribute := range request.ResourceSpans[0].Resource.Attributes {
		if attribute.Key == key {
			return attribute
		}
	}
	panic("missing fixture resource attribute")
}

func removeSpanAttribute(request *collectortracepb.ExportTraceServiceRequest, key string) {
	span := request.ResourceSpans[0].ScopeSpans[0].Spans[0]
	for index, attribute := range span.Attributes {
		if attribute.Key == key {
			span.Attributes = append(span.Attributes[:index], span.Attributes[index+1:]...)
			return
		}
	}
}

func removeGraphQuerySnapshotSurface(request *collectortracepb.ExportTraceServiceRequest) {
	for _, key := range append([]string{
		"threadnote.graph.snapshot_selection",
		"threadnote.graph.snapshot_freshness",
	}, graphQuerySnapshotBucketAttributes...) {
		removeSpanAttribute(request, key)
	}
}

func TestConfigurationAcceptsOnlyGrafanaHTTPSOTLP(t *testing.T) {
	t.Setenv("GRAFANA_CLOUD_OTLP_ENDPOINT", "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp")
	t.Setenv("GRAFANA_CLOUD_AUTHORIZATION", "Basic MTIzNDU2OnRva2Vu")
	t.Setenv(publicIngestionEnv, "enabled")
	if validationError := validateConfiguration(); validationError != nil {
		t.Fatalf("valid configuration failed: %v", validationError)
	}

	invalidEndpoints := []string{
		"http://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
		"https://example.com/otlp",
		"https://otlp-gateway-prod-eu-west-2.grafana.net/v1/traces",
		"https://otlp-gateway-prod-eu-west-2.grafana.net/otlp?private=value",
	}
	for _, endpoint := range invalidEndpoints {
		t.Setenv("GRAFANA_CLOUD_OTLP_ENDPOINT", endpoint)
		if validateConfiguration() == nil {
			t.Fatalf("invalid endpoint was accepted: %s", endpoint)
		}
	}

	t.Setenv("GRAFANA_CLOUD_OTLP_ENDPOINT", "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp")
	t.Setenv(publicIngestionEnv, "disabled")
	if validationError := validateConfiguration(); validationError != nil {
		t.Fatalf("disabled public ingestion failed configuration validation: %v", validationError)
	}
	t.Setenv(publicIngestionEnv, "typo")
	if validateConfiguration() == nil {
		t.Fatal("invalid public ingestion switch was accepted")
	}
}

func TestIngressRateLimitsAllRoutes(t *testing.T) {
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	for index := 0; index < perSourceRequestsMin+1; index++ {
		request := httptest.NewRequest(http.MethodGet, "/invalid", nil)
		request.Header.Set("Fly-Client-IP", "192.0.2.42")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		want := http.StatusNotFound
		if index == perSourceRequestsMin {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("request %d returned %d, want %d", index+1, response.Code, want)
		}
	}
}

func TestPublicIngestionKillSwitchRejectsBeforeReadingTelemetry(t *testing.T) {
	t.Setenv(publicIngestionEnv, "disabled")
	handler, handlerError := newGatewayHandler()
	if handlerError != nil {
		t.Fatal(handlerError)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/traces", nil)
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled ingress returned %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if response.Header().Get("Retry-After") != "3600" {
		t.Fatal("disabled ingress response is missing the bounded retry instruction")
	}
}

func TestAcceptedByteBudgetStaysInsideTheFreeTierEnvelope(t *testing.T) {
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	now := time.Unix(1_700_000_000, 0)
	if !limiter.allowBytes("first", acceptedBytesPerMin/2, now) ||
		!limiter.allowBytes("second", acceptedBytesPerMin/2, now) {
		t.Fatal("admitted byte budget was rejected")
	}
	if limiter.allowBytes("third", 1, now) {
		t.Fatal("global accepted byte budget was exceeded")
	}
	if !limiter.allowBytes("third", acceptedBytesPerSourceMin, now.Add(time.Minute)) {
		t.Fatal("accepted byte budget did not reset for the next minute")
	}
	if limiter.allowBytes("third", 1, now.Add(time.Minute)) {
		t.Fatal("one source exceeded its accepted byte budget")
	}
	if !limiter.allowBytes("fourth", acceptedBytesPerSourceMin, now.Add(time.Minute)) {
		t.Fatal("another source could not use the remaining global byte budget")
	}
	if maximum := budget.MaximumMonthlyCanonicalBytes(budget.ProductionMachineCount); maximum >= budget.SafeMonthlyCanonicalBytes {
		t.Fatalf("production monthly cap = %d bytes, want less than %d canonical bytes", maximum, budget.SafeMonthlyCanonicalBytes)
	}
}

func TestRejectedTelemetryDoesNotConsumeTheAcceptedByteBudget(t *testing.T) {
	schemas, schemaError := loadTelemetrySchemas()
	if schemaError != nil {
		t.Fatal(schemaError)
	}
	limiter := &requestLimiter{sources: make(map[string]windowCounter)}
	now := time.Unix(1_700_000_000, 0)
	for index := 0; index < 32; index++ {
		invalid := validTelemetryRequest()
		spanAttribute(invalid, "threadnote.operation").Value = stringAnyValue("private-operation")
		payload, marshalError := proto.Marshal(invalid)
		if marshalError != nil {
			t.Fatal(marshalError)
		}
		if canonical, validationError := canonicalTelemetryPayload(payload, schemas); validationError == nil {
			if !limiter.allowBytes("source", len(canonical), now) {
				t.Fatal("unexpected byte-budget rejection")
			}
		}
	}
	if limiter.global.bytes != 0 {
		t.Fatalf("rejected telemetry consumed %d accepted bytes", limiter.global.bytes)
	}
}

func TestOnlyPrivateMarkedHealthChecksUseDedicatedCapacity(t *testing.T) {
	private := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	private.RemoteAddr = "172.16.0.2:43123"
	private.Header.Set(trustedHealthHeader, trustedHealthValue)
	if !isTrustedHealthCheck(private) {
		t.Fatal("private Fly service check was not recognized")
	}

	public := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	public.RemoteAddr = "172.16.0.2:43123"
	public.Header.Set(trustedHealthHeader, trustedHealthValue)
	public.Header.Set("Fly-Client-IP", "192.0.2.42")
	if isTrustedHealthCheck(public) {
		t.Fatal("public health request escaped the public budget")
	}

	forged := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	forged.RemoteAddr = "192.0.2.42:43123"
	forged.Header.Set(trustedHealthHeader, trustedHealthValue)
	if isTrustedHealthCheck(forged) {
		t.Fatal("non-private marked request escaped the public budget")
	}
}

func TestRequestSourceIsEphemerallyPseudonymized(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Fly-Client-IP", "192.0.2.42")
	value := requestSource(request, bytes.Repeat([]byte{7}, 32))
	if strings.Contains(value, "192.0.2.42") || len(value) != 32 {
		t.Fatalf("source key is not a bounded pseudonym: %q", value)
	}
}
