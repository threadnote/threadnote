package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	collectortracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

//go:embed telemetry-schema-v1.json
var telemetrySchemaV1JSON []byte

//go:embed telemetry-schema-v2.json
var telemetrySchemaV2JSON []byte

//go:embed telemetry-schema-v3.json
var telemetrySchemaV3JSON []byte

//go:embed telemetry-schema-v4.json
var telemetrySchemaV4JSON []byte

//go:embed telemetry-schema-v5.json
var telemetrySchemaV5JSON []byte

//go:embed telemetry-schema-v6.json
var telemetrySchemaV6JSON []byte

//go:embed telemetry-schema-v7.json
var telemetrySchemaV7JSON []byte

type telemetrySchema struct {
	SchemaVersion int `json:"schemaVersion"`
	Limits        struct {
		MaxSpansPerRequest int   `json:"maxSpansPerRequest"`
		MaxSafeInteger     int64 `json:"maxSafeInteger"`
		MaxVersionBytes    int   `json:"maxVersionBytes"`
	} `json:"limits"`
	Patterns struct {
		InvocationID   string `json:"invocationId"`
		QuantityBucket string `json:"quantityBucket"`
		RuntimeLabel   string `json:"runtimeLabel"`
		ServiceVersion string `json:"serviceVersion"`
		SessionID      string `json:"sessionId"`
	} `json:"patterns"`
	AttributeContract struct {
		BooleanSpan        []string `json:"booleanSpan"`
		IntegerSpan        []string `json:"integerSpan"`
		MemoryBucketSpan   []string `json:"memoryBucketSpan"`
		QuantityBucketSpan []string `json:"quantityBucketSpan"`
		RequiredSpan       []string `json:"requiredSpan"`
		Resource           []string `json:"resource"`
		Span               []string `json:"span"`
	} `json:"attributeContract"`
	Registries map[string][]string `json:"registries"`
}

type compiledTelemetrySchema struct {
	telemetrySchema
	booleanSpan        map[string]struct{}
	integerSpan        map[string]struct{}
	memoryBucketSpan   map[string]struct{}
	patterns           map[string]*regexp.Regexp
	quantityBucketSpan map[string]struct{}
	registries         map[string]map[string]struct{}
	requiredSpan       map[string]struct{}
	resourceAttributes map[string]struct{}
	spanAttributes     map[string]struct{}
}

type compiledTelemetrySchemas struct {
	byVersion map[int]*compiledTelemetrySchema
}

var graphRegistrySpanAttributes = map[string]string{
	"threadnote.graph.build_kind":           "buildKind",
	"threadnote.graph.efficiency_class":     "efficiencyClass",
	"threadnote.graph.fallback_reason":      "fallbackReason",
	"threadnote.graph.materialization_mode": "materializationMode",
	"threadnote.graph.resolution_closure":   "resolutionClosure",
}

var graphQueryRegistrySpanAttributes = map[string]string{
	"threadnote.graph.request_kind":       "graphRequestKind",
	"threadnote.graph.request_scope":      "graphRequestScope",
	"threadnote.graph.snapshot_freshness": "graphSnapshotFreshness",
	"threadnote.graph.snapshot_selection": "graphSnapshotSelection",
}

var contextBriefRegistrySpanAttributes = map[string]string{
	"threadnote.context_brief.code_anchor_coverage":    "contextBriefCodeAnchorCoverage",
	"threadnote.context_brief.citation_coverage":       "contextBriefCitationCoverage",
	"threadnote.context_brief.citation_result":         "contextBriefCitationResult",
	"threadnote.context_brief.citation_unknown_reason": "contextBriefCitationUnknownReason",
	"threadnote.context_brief.contract":                "contextBriefContract",
	"threadnote.context_brief.gap_class":               "contextBriefGapClass",
	"threadnote.context_brief.mode":                    "contextBriefMode",
	"threadnote.context_brief.returned_lane":           "contextBriefReturnedLane",
	"threadnote.context_brief.scope":                   "contextBriefScope",
}

var codeAnchorFinalizationRegistrySpanAttributes = map[string]string{
	"threadnote.code_anchor_finalization.result":  "codeAnchorFinalizationResult",
	"threadnote.code_anchor_finalization.trigger": "codeAnchorFinalizationTrigger",
}

var contextBriefCitationBucketAttributes = []string{
	"threadnote.context_brief.cache_hits_bucket",
	"threadnote.context_brief.citations_bucket",
	"threadnote.context_brief.cited_memories_bucket",
	"threadnote.context_brief.exact_citations_bucket",
	"threadnote.context_brief.relocated_citations_bucket",
	"threadnote.context_brief.repositories_validated_bucket",
	"threadnote.context_brief.stale_citations_bucket",
	"threadnote.context_brief.unknown_citations_bucket",
}

var contextBriefCodeAnchorBucketAttributes = []string{
	"threadnote.context_brief.code_anchors_matched_memories_bucket",
	"threadnote.context_brief.code_anchors_requested_bucket",
	"threadnote.context_brief.code_anchors_resolved_bucket",
}

var codeAnchorFinalizationBucketAttributes = []string{
	"threadnote.code_anchor_finalization.conflict_bucket",
	"threadnote.code_anchor_finalization.failed_bucket",
	"threadnote.code_anchor_finalization.finalized_bucket",
	"threadnote.code_anchor_finalization.latency_ms_bucket",
	"threadnote.code_anchor_finalization.matched_bucket",
	"threadnote.code_anchor_finalization.pending_bucket",
	"threadnote.code_anchor_finalization.scanned_bucket",
}

var graphQuerySnapshotBucketAttributes = []string{
	"threadnote.graph.snapshot_edges_bucket",
	"threadnote.graph.snapshot_files_bucket",
	"threadnote.graph.snapshot_symbols_bucket",
}

var terminalGraphSpanAttributes = []string{
	"threadnote.graph.build_kind",
	"threadnote.graph.cached_fact_replay_bytes_bucket",
	"threadnote.graph.changed_fact_bytes_bucket",
	"threadnote.graph.changed_files_bucket",
	"threadnote.graph.deleted_files_bucket",
	"threadnote.graph.delta_files_bucket",
	"threadnote.graph.efficiency_class",
	"threadnote.graph.extracted_files_bucket",
	"threadnote.graph.fact_replay_amplification_bucket",
	"threadnote.graph.fallback_reason",
	"threadnote.graph.final_fact_bytes_bucket",
	"threadnote.graph.materialization_mode",
	"threadnote.graph.resolution_closure",
	"threadnote.graph.reused_files_bucket",
	"threadnote.graph.rewrite_amplification_bucket",
	"threadnote.graph.staged_files_bucket",
	"threadnote.graph.total_files_bucket",
}

func loadTelemetrySchemas() (*compiledTelemetrySchemas, error) {
	result := &compiledTelemetrySchemas{byVersion: make(map[int]*compiledTelemetrySchema, 7)}
	for version, data := range map[int][]byte{1: telemetrySchemaV1JSON, 2: telemetrySchemaV2JSON, 3: telemetrySchemaV3JSON, 4: telemetrySchemaV4JSON, 5: telemetrySchemaV5JSON, 6: telemetrySchemaV6JSON, 7: telemetrySchemaV7JSON} {
		compiled, err := compileTelemetrySchema(data, version)
		if err != nil {
			return nil, err
		}
		result.byVersion[version] = compiled
	}
	return result, nil
}

func compileTelemetrySchema(data []byte, expectedVersion int) (*compiledTelemetrySchema, error) {
	var raw telemetrySchema
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode telemetry schema: %w", err)
	}
	if raw.SchemaVersion != expectedVersion || raw.Limits.MaxSpansPerRequest < 1 || raw.Limits.MaxSafeInteger != 9007199254740991 || raw.Limits.MaxVersionBytes < 1 {
		return nil, errors.New("invalid telemetry schema version or limits")
	}
	compiled := &compiledTelemetrySchema{
		telemetrySchema:    raw,
		booleanSpan:        stringSet(raw.AttributeContract.BooleanSpan),
		integerSpan:        stringSet(raw.AttributeContract.IntegerSpan),
		memoryBucketSpan:   stringSet(raw.AttributeContract.MemoryBucketSpan),
		quantityBucketSpan: stringSet(raw.AttributeContract.QuantityBucketSpan),
		registries:         make(map[string]map[string]struct{}, len(raw.Registries)),
		requiredSpan:       stringSet(raw.AttributeContract.RequiredSpan),
		resourceAttributes: stringSet(raw.AttributeContract.Resource),
		spanAttributes:     stringSet(raw.AttributeContract.Span),
		patterns:           make(map[string]*regexp.Regexp, 5),
	}
	for name, values := range raw.Registries {
		compiled.registries[name] = stringSet(values)
	}
	for name, pattern := range map[string]string{
		"invocationId": raw.Patterns.InvocationID, "quantityBucket": raw.Patterns.QuantityBucket,
		"runtimeLabel": raw.Patterns.RuntimeLabel, "serviceVersion": raw.Patterns.ServiceVersion,
		"sessionId": raw.Patterns.SessionID,
	} {
		value, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("compile telemetry schema pattern %s: %w", name, err)
		}
		compiled.patterns[name] = value
	}
	requiredRegistries := []string{"component", "correlationScope", "degradationReason", "errorType", "event", "failureCode", "failureDomain", "failureOperation", "failureReason", "failureRecovery", "memoryBucket", "modelWorkerOperation", "operation", "outcome", "phase", "stage", "subphase", "waitingReason"}
	if expectedVersion >= 2 {
		requiredRegistries = append(requiredRegistries, "buildKind", "efficiencyClass", "fallbackReason", "materializationMode", "resolutionClosure")
	}
	if expectedVersion >= 3 {
		requiredRegistries = append(requiredRegistries, "autoUpdateResult")
	}
	if expectedVersion >= 4 {
		requiredRegistries = append(requiredRegistries,
			"graphRequestKind",
			"graphRequestScope",
			"graphSnapshotFreshness",
			"graphSnapshotSelection",
		)
	}
	if expectedVersion >= 5 {
		requiredRegistries = append(requiredRegistries,
			"contextBriefCitationCoverage",
			"contextBriefCitationResult",
			"contextBriefCitationUnknownReason",
			"contextBriefScope",
		)
	}
	if expectedVersion >= 6 {
		requiredRegistries = append(requiredRegistries,
			"codeAnchorFinalizationResult",
			"codeAnchorFinalizationTrigger",
			"contextBriefCodeAnchorCoverage",
			"contextBriefContract",
			"contextBriefGapClass",
			"contextBriefMode",
			"contextBriefReturnedLane",
		)
	}
	for _, registry := range requiredRegistries {
		if len(compiled.registries[registry]) == 0 {
			return nil, fmt.Errorf("empty telemetry schema registry %s", registry)
		}
	}
	return compiled, nil
}

func stringSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		result[value] = struct{}{}
	}
	return result
}

func canonicalTelemetryPayload(payload []byte, schemas *compiledTelemetrySchemas) ([]byte, error) {
	if err := validateTelemetryWire(payload); err != nil {
		return nil, err
	}
	request := &collectortracepb.ExportTraceServiceRequest{}
	if err := (proto.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(payload, request); err != nil {
		return nil, errors.New("invalid OTLP protobuf")
	}
	if err := rejectUnknownProto(request.ProtoReflect()); err != nil {
		return nil, err
	}
	schema, err := selectTelemetrySchema(request, schemas)
	if err != nil {
		return nil, err
	}
	if err := validateTelemetryRequest(request, schema); err != nil {
		return nil, err
	}
	clean := freshTelemetryRequest(request)
	canonical, err := (proto.MarshalOptions{Deterministic: true}).Marshal(clean)
	if err != nil {
		return nil, errors.New("marshal canonical OTLP protobuf")
	}
	return canonical, nil
}

func selectTelemetrySchema(request *collectortracepb.ExportTraceServiceRequest, schemas *compiledTelemetrySchemas) (*compiledTelemetrySchema, error) {
	if schemas == nil || len(request.ResourceSpans) != 1 || request.ResourceSpans[0] == nil || request.ResourceSpans[0].Resource == nil {
		return nil, errors.New("invalid telemetry schema envelope")
	}
	var version int64
	found := false
	for _, attribute := range request.ResourceSpans[0].Resource.Attributes {
		if attribute == nil || attribute.Key != "threadnote.telemetry.schema_version" {
			continue
		}
		if found || attribute.Value == nil {
			return nil, errors.New("invalid telemetry schema version")
		}
		var ok bool
		version, ok = anyInt(attribute.Value)
		if !ok {
			return nil, errors.New("invalid telemetry schema version")
		}
		found = true
	}
	if !found {
		return nil, errors.New("missing telemetry schema version")
	}
	schema, admitted := schemas.byVersion[int(version)]
	if !admitted {
		return nil, errors.New("unsupported telemetry schema version")
	}
	return schema, nil
}

type wireMessageKind uint8

const (
	wireExport wireMessageKind = iota
	wireResourceSpans
	wireResource
	wireScopeSpans
	wireScope
	wireSpan
	wireStatus
	wireKeyValue
	wireAnyValue
)

var wireContracts = map[wireMessageKind]map[protowire.Number]struct {
	kind     wireMessageKind
	repeated bool
	wireType protowire.Type
}{
	wireExport:        {1: {kind: wireResourceSpans, repeated: true, wireType: protowire.BytesType}},
	wireResourceSpans: {1: {kind: wireResource, wireType: protowire.BytesType}, 2: {kind: wireScopeSpans, repeated: true, wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}},
	wireResource:      {1: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 2: {wireType: protowire.VarintType}},
	wireScopeSpans:    {1: {kind: wireScope, wireType: protowire.BytesType}, 2: {kind: wireSpan, repeated: true, wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}},
	wireScope:         {1: {wireType: protowire.BytesType}, 2: {wireType: protowire.BytesType}, 3: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 4: {wireType: protowire.VarintType}},
	wireSpan: {
		1: {wireType: protowire.BytesType}, 2: {wireType: protowire.BytesType}, 3: {wireType: protowire.BytesType}, 4: {wireType: protowire.BytesType},
		5: {wireType: protowire.BytesType}, 6: {wireType: protowire.VarintType}, 7: {wireType: protowire.Fixed64Type}, 8: {wireType: protowire.Fixed64Type},
		9: {kind: wireKeyValue, repeated: true, wireType: protowire.BytesType}, 10: {wireType: protowire.VarintType}, 11: {repeated: true, wireType: protowire.BytesType},
		12: {wireType: protowire.VarintType}, 13: {repeated: true, wireType: protowire.BytesType}, 14: {wireType: protowire.VarintType},
		15: {kind: wireStatus, wireType: protowire.BytesType}, 16: {wireType: protowire.Fixed32Type},
	},
	wireStatus:   {2: {wireType: protowire.BytesType}, 3: {wireType: protowire.VarintType}},
	wireKeyValue: {1: {wireType: protowire.BytesType}, 2: {kind: wireAnyValue, wireType: protowire.BytesType}},
	wireAnyValue: {
		1: {wireType: protowire.BytesType}, 2: {wireType: protowire.VarintType}, 3: {wireType: protowire.VarintType}, 4: {wireType: protowire.Fixed64Type},
		5: {wireType: protowire.BytesType}, 6: {wireType: protowire.BytesType}, 7: {wireType: protowire.BytesType},
	},
}

func validateTelemetryWire(payload []byte) error {
	return validateWireMessage(payload, wireExport)
}

func validateWireMessage(payload []byte, kind wireMessageKind) error {
	seen := make(map[protowire.Number]struct{})
	contract := wireContracts[kind]
	for len(payload) > 0 {
		number, wireType, tagLength := protowire.ConsumeTag(payload)
		if tagLength < 0 {
			return errors.New("invalid OTLP protobuf tag")
		}
		field, admitted := contract[number]
		if !admitted || field.wireType != wireType {
			return errors.New("invalid OTLP protobuf field")
		}
		if _, duplicate := seen[number]; duplicate && !field.repeated {
			return errors.New("duplicate OTLP protobuf singular field")
		}
		if kind == wireAnyValue && len(seen) != 0 {
			return errors.New("OTLP AnyValue contains multiple oneof fields")
		}
		seen[number] = struct{}{}
		payload = payload[tagLength:]
		var value []byte
		var consumed int
		switch wireType {
		case protowire.VarintType:
			_, consumed = protowire.ConsumeVarint(payload)
		case protowire.Fixed32Type:
			_, consumed = protowire.ConsumeFixed32(payload)
		case protowire.Fixed64Type:
			_, consumed = protowire.ConsumeFixed64(payload)
		case protowire.BytesType:
			value, consumed = protowire.ConsumeBytes(payload)
		default:
			return errors.New("unsupported OTLP protobuf wire type")
		}
		if consumed < 0 {
			return errors.New("invalid OTLP protobuf field value")
		}
		if wireType == protowire.BytesType && field.kind != 0 {
			if err := validateWireMessage(value, field.kind); err != nil {
				return err
			}
		}
		payload = payload[consumed:]
	}
	return nil
}

func freshTelemetryRequest(request *collectortracepb.ExportTraceServiceRequest) *collectortracepb.ExportTraceServiceRequest {
	resourceSpans := request.ResourceSpans[0]
	scopeSpans := resourceSpans.ScopeSpans[0]
	spans := make([]*tracepb.Span, len(scopeSpans.Spans))
	for index, span := range scopeSpans.Spans {
		spans[index] = &tracepb.Span{
			TraceId: append([]byte(nil), span.TraceId...), SpanId: append([]byte(nil), span.SpanId...), Name: span.Name,
			Kind: span.Kind, StartTimeUnixNano: span.StartTimeUnixNano, EndTimeUnixNano: span.EndTimeUnixNano,
			Attributes: freshAttributes(span.Attributes), Status: &tracepb.Status{Code: span.Status.Code},
		}
	}
	return &collectortracepb.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{
		Resource:   &resourcepb.Resource{Attributes: freshAttributes(resourceSpans.Resource.Attributes)},
		ScopeSpans: []*tracepb.ScopeSpans{{Scope: &commonpb.InstrumentationScope{Name: scopeSpans.Scope.Name}, Spans: spans}},
	}}}
}

func freshAttributes(attributes []*commonpb.KeyValue) []*commonpb.KeyValue {
	result := make([]*commonpb.KeyValue, len(attributes))
	for index, attribute := range attributes {
		value := &commonpb.AnyValue{}
		switch typed := attribute.Value.Value.(type) {
		case *commonpb.AnyValue_StringValue:
			value.Value = &commonpb.AnyValue_StringValue{StringValue: typed.StringValue}
		case *commonpb.AnyValue_BoolValue:
			value.Value = &commonpb.AnyValue_BoolValue{BoolValue: typed.BoolValue}
		case *commonpb.AnyValue_IntValue:
			value.Value = &commonpb.AnyValue_IntValue{IntValue: typed.IntValue}
		}
		result[index] = &commonpb.KeyValue{Key: attribute.Key, Value: value}
	}
	return result
}

func rejectUnknownProto(message protoreflect.Message) error {
	if len(message.GetUnknown()) != 0 {
		return errors.New("OTLP protobuf contains unknown fields")
	}
	var nestedError error
	message.Range(func(descriptor protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if descriptor.IsMap() {
			if descriptor.MapValue().Kind() == protoreflect.MessageKind {
				value.Map().Range(func(_ protoreflect.MapKey, mapped protoreflect.Value) bool {
					nestedError = rejectUnknownProto(mapped.Message())
					return nestedError == nil
				})
			}
			return nestedError == nil
		}
		if descriptor.IsList() && descriptor.Kind() == protoreflect.MessageKind {
			list := value.List()
			for index := 0; index < list.Len(); index++ {
				if nestedError = rejectUnknownProto(list.Get(index).Message()); nestedError != nil {
					return false
				}
			}
			return true
		}
		if descriptor.Kind() == protoreflect.MessageKind {
			nestedError = rejectUnknownProto(value.Message())
			return nestedError == nil
		}
		return true
	})
	return nestedError
}

func validateTelemetryRequest(request *collectortracepb.ExportTraceServiceRequest, schema *compiledTelemetrySchema) error {
	if len(request.ResourceSpans) != 1 || request.ResourceSpans[0] == nil {
		return errors.New("telemetry request must contain one resource span group")
	}
	resourceSpans := request.ResourceSpans[0]
	if resourceSpans.SchemaUrl != "" || resourceSpans.Resource == nil || resourceSpans.Resource.DroppedAttributesCount != 0 {
		return errors.New("invalid telemetry resource envelope")
	}
	resource, err := attributesByKey(resourceSpans.Resource.Attributes, schema.resourceAttributes)
	if err != nil || len(resource) != len(schema.resourceAttributes) {
		return errors.New("invalid telemetry resource attributes")
	}
	if !stringAttributeEquals(resource, "service.name", "threadnote") ||
		!stringAttributeMatchesBounded(resource, "service.version", schema.patterns["serviceVersion"], schema.Limits.MaxVersionBytes) ||
		!stringAttributeMatches(resource, "session.id", schema.patterns["sessionId"]) ||
		!stringAttributeIn(resource, "threadnote.session.scope", schema.registries["correlationScope"]) ||
		!intAttributeEquals(resource, "threadnote.telemetry.schema_version", int64(schema.SchemaVersion)) {
		return errors.New("invalid telemetry resource values")
	}
	if len(resourceSpans.ScopeSpans) != 1 || resourceSpans.ScopeSpans[0] == nil {
		return errors.New("telemetry request must contain one scope span group")
	}
	scopeSpans := resourceSpans.ScopeSpans[0]
	if scopeSpans.SchemaUrl != "" || scopeSpans.Scope == nil || scopeSpans.Scope.Name != "threadnote" ||
		scopeSpans.Scope.Version != "" || len(scopeSpans.Scope.Attributes) != 0 || scopeSpans.Scope.DroppedAttributesCount != 0 ||
		len(scopeSpans.Spans) == 0 || len(scopeSpans.Spans) > schema.Limits.MaxSpansPerRequest {
		return errors.New("invalid telemetry scope envelope")
	}
	traceIDs := make(map[string]struct{}, len(scopeSpans.Spans))
	spanIDs := make(map[string]struct{}, len(scopeSpans.Spans))
	for _, span := range scopeSpans.Spans {
		if err := validateTelemetrySpan(span, schema, traceIDs, spanIDs); err != nil {
			return err
		}
	}
	return nil
}

func validateTelemetrySpan(span *tracepb.Span, schema *compiledTelemetrySchema, traceIDs, spanIDs map[string]struct{}) error {
	if span == nil || !nonzeroID(span.TraceId, 16) || !nonzeroID(span.SpanId, 8) || len(span.ParentSpanId) != 0 ||
		span.TraceState != "" || span.Name != "threadnote.anonymous-diagnostic" || span.Kind != tracepb.Span_SPAN_KIND_INTERNAL ||
		span.StartTimeUnixNano == 0 || span.EndTimeUnixNano < span.StartTimeUnixNano || span.Flags != 0 ||
		span.DroppedAttributesCount != 0 || len(span.Events) != 0 || span.DroppedEventsCount != 0 || len(span.Links) != 0 || span.DroppedLinksCount != 0 ||
		span.Status == nil || span.Status.Code != tracepb.Status_STATUS_CODE_OK || span.Status.Message != "" {
		return errors.New("invalid telemetry span envelope")
	}
	traceID, spanID := string(span.TraceId), string(span.SpanId)
	if _, exists := traceIDs[traceID]; exists {
		return errors.New("duplicate telemetry trace id")
	}
	if _, exists := spanIDs[spanID]; exists {
		return errors.New("duplicate telemetry span id")
	}
	traceIDs[traceID], spanIDs[spanID] = struct{}{}, struct{}{}
	attributes, err := attributesByKey(span.Attributes, schema.spanAttributes)
	if err != nil {
		return err
	}
	for key := range schema.requiredSpan {
		if _, exists := attributes[key]; !exists {
			return errors.New("missing required telemetry span attribute")
		}
	}
	if err := validateSpanAttributeValues(attributes, schema); err != nil {
		return err
	}
	return validateSpanAttributeShape(attributes, schema)
}

func attributesByKey(attributes []*commonpb.KeyValue, allowed map[string]struct{}) (map[string]*commonpb.AnyValue, error) {
	result := make(map[string]*commonpb.AnyValue, len(attributes))
	for _, attribute := range attributes {
		if attribute == nil || attribute.Key == "" || attribute.Value == nil {
			return nil, errors.New("invalid telemetry attribute")
		}
		if _, admitted := allowed[attribute.Key]; !admitted {
			return nil, errors.New("unknown telemetry attribute")
		}
		if _, duplicate := result[attribute.Key]; duplicate {
			return nil, errors.New("duplicate telemetry attribute")
		}
		result[attribute.Key] = attribute.Value
	}
	return result, nil
}

func validateSpanAttributeValues(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema) error {
	for key, value := range attributes {
		switch {
		case key == "threadnote.component":
			if !valueStringIn(value, schema.registries["component"]) {
				return errors.New("invalid telemetry component")
			}
		case key == "threadnote.event":
			if !valueStringIn(value, schema.registries["event"]) {
				return errors.New("invalid telemetry event")
			}
		case key == "threadnote.operation":
			if !valueStringIn(value, schema.registries["operation"]) {
				return errors.New("invalid telemetry operation")
			}
		case key == "threadnote.runtime.architecture" || key == "threadnote.runtime.platform":
			if !valueStringMatches(value, schema.patterns["runtimeLabel"]) {
				return errors.New("invalid telemetry runtime label")
			}
		case key == "threadnote.runtime.version":
			if !valueStringMatchesBounded(value, schema.patterns["serviceVersion"], schema.Limits.MaxVersionBytes) {
				return errors.New("invalid telemetry runtime version")
			}
		case key == "threadnote.invocation.id":
			if !valueStringMatches(value, schema.patterns["invocationId"]) {
				return errors.New("invalid telemetry invocation id")
			}
		case key == "threadnote.outcome" || key == "threadnote.phase.outcome":
			if !valueStringIn(value, schema.registries["outcome"]) {
				return errors.New("invalid telemetry outcome")
			}
		case key == "threadnote.phase":
			if !valueStringIn(value, schema.registries["phase"]) {
				return errors.New("invalid telemetry phase")
			}
		case key == "threadnote.stage":
			if !valueStringIn(value, schema.registries["stage"]) {
				return errors.New("invalid telemetry stage")
			}
		case key == "threadnote.subphase":
			if !valueStringIn(value, schema.registries["subphase"]) {
				return errors.New("invalid telemetry subphase")
			}
		case key == "threadnote.waiting_reason":
			if !valueStringIn(value, schema.registries["waitingReason"]) {
				return errors.New("invalid telemetry waiting reason")
			}
		case key == "threadnote.graph.degradation_reason":
			if !valueStringIn(value, schema.registries["degradationReason"]) {
				return errors.New("invalid telemetry degradation reason")
			}
		case key == "error.type":
			if !valueStringIn(value, schema.registries["errorType"]) {
				return errors.New("invalid telemetry error type")
			}
		case key == "threadnote.failure.domain":
			if !valueStringIn(value, schema.registries["failureDomain"]) {
				return errors.New("invalid telemetry failure domain")
			}
		case key == "threadnote.failure.code":
			if !valueStringIn(value, schema.registries["failureCode"]) {
				return errors.New("invalid telemetry failure code")
			}
		case key == "threadnote.failure.operation":
			if !valueStringIn(value, schema.registries["failureOperation"]) && !valueStringIn(value, schema.registries["modelWorkerOperation"]) {
				return errors.New("invalid telemetry failure operation")
			}
		case key == "threadnote.failure.reason":
			if !valueStringIn(value, schema.registries["failureReason"]) {
				return errors.New("invalid telemetry failure reason")
			}
		case key == "threadnote.failure.recovery":
			if !valueStringIn(value, schema.registries["failureRecovery"]) {
				return errors.New("invalid telemetry failure recovery")
			}
		case key == "threadnote.auto_update.result":
			if !valueStringIn(value, schema.registries["autoUpdateResult"]) {
				return errors.New("invalid telemetry automatic update result")
			}
		case graphRegistrySpanAttributes[key] != "":
			if !valueStringIn(value, schema.registries[graphRegistrySpanAttributes[key]]) {
				return errors.New("invalid telemetry graph classification")
			}
		case graphQueryRegistrySpanAttributes[key] != "":
			if !valueStringIn(value, schema.registries[graphQueryRegistrySpanAttributes[key]]) {
				return errors.New("invalid telemetry graph query classification")
			}
		case contextBriefRegistrySpanAttributes[key] != "":
			if !valueStringIn(value, schema.registries[contextBriefRegistrySpanAttributes[key]]) {
				return errors.New("invalid telemetry context brief classification")
			}
		case codeAnchorFinalizationRegistrySpanAttributes[key] != "":
			if !valueStringIn(value, schema.registries[codeAnchorFinalizationRegistrySpanAttributes[key]]) {
				return errors.New("invalid telemetry code anchor finalization classification")
			}
		case contains(schema.booleanSpan, key):
			if _, ok := value.Value.(*commonpb.AnyValue_BoolValue); !ok {
				return errors.New("invalid telemetry boolean attribute")
			}
		case contains(schema.integerSpan, key):
			integer, ok := anyInt(value)
			if !ok || integer < 0 || integer > schema.Limits.MaxSafeInteger {
				return errors.New("invalid telemetry integer attribute")
			}
		case contains(schema.memoryBucketSpan, key):
			if !valueStringIn(value, schema.registries["memoryBucket"]) {
				return errors.New("invalid telemetry memory bucket")
			}
		case contains(schema.quantityBucketSpan, key):
			if !valueStringMatches(value, schema.patterns["quantityBucket"]) {
				return errors.New("invalid telemetry quantity bucket")
			}
		default:
			return errors.New("unvalidated telemetry attribute")
		}
	}
	return nil
}

func validateSpanAttributeShape(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema) error {
	event, _ := anyString(attributes["threadnote.event"])
	_, duration := attributes["threadnote.duration_ms"]
	_, outcome := attributes["threadnote.outcome"]
	if event == "completion" && (!duration || !outcome) {
		return errors.New("telemetry completion requires duration and outcome")
	}
	if event != "completion" && duration != outcome {
		return errors.New("telemetry event duration and outcome must be paired")
	}
	current, start, end := memoryGroups(attributes)
	if event == "completion" {
		if current != 0 || (start != 0 && start != 4) || (end != 0 && end != 4) || (end == 4 && start != 4) {
			return errors.New("invalid telemetry completion memory shape")
		}
	} else if start != 0 || end != 0 || (current != 0 && current != 4) {
		return errors.New("invalid telemetry event memory shape")
	}
	domain, hasDomain := anyString(attributes["threadnote.failure.domain"])
	failureKeys := 0
	for _, key := range []string{"threadnote.failure.code", "threadnote.failure.operation", "threadnote.failure.reason", "threadnote.failure.recovery", "threadnote.failure.retryable"} {
		if _, exists := attributes[key]; exists {
			failureKeys++
		}
	}
	if !hasDomain && failureKeys != 0 {
		return errors.New("failure details require a domain")
	}
	if domain == "model-worker" {
		operation, exists := anyString(attributes["threadnote.failure.operation"])
		if !exists || !contains(schema.registries["modelWorkerOperation"], operation) {
			return errors.New("model failure requires a model operation")
		}
		if _, exists := attributes["threadnote.failure.reason"]; !exists {
			return errors.New("model failure requires reason")
		}
		for _, key := range []string{"threadnote.failure.code", "threadnote.failure.recovery", "threadnote.failure.retryable"} {
			if _, exists := attributes[key]; exists {
				return errors.New("invalid model failure shape")
			}
		}
	}
	if domain == "code-graph-storage" {
		if _, exists := attributes["threadnote.failure.reason"]; exists {
			return errors.New("invalid storage failure shape")
		}
		if operation, exists := anyString(attributes["threadnote.failure.operation"]); exists && !contains(schema.registries["failureOperation"], operation) {
			return errors.New("invalid storage failure operation")
		}
	}
	if _, exists := attributes["threadnote.phase.outcome"]; exists {
		if _, phase := attributes["threadnote.phase"]; !phase {
			return errors.New("phase outcome requires phase")
		}
		if _, elapsed := attributes["threadnote.phase.elapsed_ms"]; !elapsed {
			return errors.New("phase outcome requires elapsed time")
		}
	}
	operation, _ := anyString(attributes["threadnote.operation"])
	graphAttributeCount := 0
	for _, key := range terminalGraphSpanAttributes {
		if _, exists := attributes[key]; exists {
			graphAttributeCount++
		}
	}
	if graphAttributeCount != 0 && (schema.SchemaVersion < 2 || event != "lifecycle" || operation != "graph-build") {
		return errors.New("graph build attributes require a version 2 or later graph lifecycle event")
	}
	autoUpdateResult, hasAutoUpdateResult := anyString(attributes["threadnote.auto_update.result"])
	_, hasAutoUpdateRepairRequired := attributes["threadnote.auto_update.repair_required"]
	if (hasAutoUpdateResult || hasAutoUpdateRepairRequired) &&
		(schema.SchemaVersion < 3 || event != "completion" || operation != "auto-update-worker") {
		return errors.New("automatic update attributes require a version 3 or later worker completion")
	}
	if schema.SchemaVersion >= 3 && event == "completion" && operation == "auto-update-worker" {
		outcomeValue, _ := anyString(attributes["threadnote.outcome"])
		if outcomeValue == "success" && !hasAutoUpdateResult {
			return errors.New("successful automatic update worker completion requires a closed result")
		}
		if hasAutoUpdateRepairRequired != (autoUpdateResult == "updated") {
			return errors.New("automatic update repair state requires an updated result")
		}
	}
	if event == "lifecycle" {
		outcomeValue, _ := anyString(attributes["threadnote.outcome"])
		if schema.SchemaVersion >= 2 && operation == "graph-build" {
			if outcomeValue != "success" && outcomeValue != "failure" && outcomeValue != "interrupted" {
				return errors.New("graph build lifecycle event requires a terminal outcome")
			}
			if outcomeValue == "success" && graphAttributeCount != len(terminalGraphSpanAttributes) {
				return errors.New("successful graph build lifecycle event requires the complete graph surface")
			}
			if outcomeValue != "success" && graphAttributeCount != 0 {
				return errors.New("non-successful graph build lifecycle event cannot include a partial graph surface")
			}
			if outcomeValue == "failure" {
				if _, exists := attributes["error.type"]; !exists {
					return errors.New("failed graph build lifecycle event requires error type")
				}
			}
			if outcomeValue == "interrupted" {
				if _, exists := attributes["error.type"]; exists {
					return errors.New("interrupted graph build lifecycle event cannot include error type")
				}
			}
		} else {
			if outcomeValue != "failure" {
				return errors.New("lifecycle event requires failure outcome")
			}
			if _, exists := attributes["error.type"]; !exists {
				return errors.New("lifecycle event requires error type")
			}
		}
	}
	if err := validateGraphQueryAttributeShape(attributes, schema, event, operation); err != nil {
		return err
	}
	if err := validateContextBriefAttributeShape(attributes, schema, event, operation); err != nil {
		return err
	}
	if err := validateRecallRefreshAttributeShape(attributes, event, operation); err != nil {
		return err
	}
	return validateCodeAnchorFinalizationAttributeShape(attributes, schema, event, operation)
}

func validateRecallRefreshAttributeShape(attributes map[string]*commonpb.AnyValue, event, operation string) error {
	countFields := 0
	for _, key := range []string{
		"threadnote.recall.read_compaction_bucket",
		"threadnote.recall.read_current_bucket",
		"threadnote.recall.read_refreshable_bucket",
		"threadnote.recall.read_serving_older_bucket",
	} {
		if _, exists := attributes[key]; exists {
			countFields++
		}
	}
	_, build := attributes["threadnote.recall.refresh_build_ms_bucket"]
	_, stale := attributes["threadnote.recall.refresh_stale_ms_bucket"]
	if countFields == 0 && !build && !stale {
		return nil
	}
	if event != "completion" || (operation != "recall" && operation != "recall_context") {
		return errors.New("recall refresh attributes require a recall completion")
	}
	if countFields != 4 || (stale && !build) {
		return errors.New("incomplete recall refresh telemetry")
	}
	return nil
}

func validateContextBriefAttributeShape(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema, event, operation string) error {
	if schema.SchemaVersion >= 6 {
		return validateContextBriefV6AttributeShape(attributes, event, operation)
	}
	phase, hasPhase := anyString(attributes["threadnote.phase"])
	contextPhase := strings.HasPrefix(phase, "context.brief.")
	contextOperation := operation == "context_brief" || operation == "context.brief"
	contextAttributeCount := 0
	for key := range contextBriefRegistrySpanAttributes {
		if _, exists := attributes[key]; exists {
			contextAttributeCount++
		}
	}
	for _, key := range contextBriefCitationBucketAttributes {
		if _, exists := attributes[key]; exists {
			contextAttributeCount++
		}
	}
	if _, exists := attributes["threadnote.context_brief.output_truncated"]; exists {
		contextAttributeCount++
	}

	if !contextOperation {
		if contextPhase || contextAttributeCount != 0 {
			return errors.New("context brief attributes require a context brief operation")
		}
		return nil
	}
	if schema.SchemaVersion < 5 || (!contextPhase && contextAttributeCount == 0) {
		return nil
	}
	if !contextPhase {
		_, hasScope := attributes["threadnote.context_brief.scope"]
		_, hasOperationElapsed := anyInt(attributes["threadnote.operation.elapsed_ms"])
		if contextAttributeCount == 1 && hasScope &&
			((event == "checkpoint" && hasOperationElapsed) || event == "completion") {
			return nil
		}
		return errors.New("context brief telemetry requires a closed context brief phase")
	}
	if !hasPhase {
		return errors.New("context brief telemetry requires a closed context brief phase")
	}
	if _, hasScope := attributes["threadnote.context_brief.scope"]; !hasScope {
		return errors.New("context brief telemetry requires scope")
	}

	validationFieldCount := contextBriefCitationValidationFieldCount(attributes)
	_, hasOutputTruncated := attributes["threadnote.context_brief.output_truncated"]
	if event == "checkpoint" {
		outcome, hasOutcome := anyString(attributes["threadnote.phase.outcome"])
		if !hasOutcome {
			return errors.New("context brief checkpoint requires phase outcome")
		}
		if outcome != "success" {
			if validationFieldCount != 0 || hasOutputTruncated {
				return errors.New("non-successful context brief checkpoint cannot include result fields")
			}
			return nil
		}
		switch phase {
		case "context.brief.citation-validation":
			if hasOutputTruncated || !hasCompleteContextBriefCitationSurface(attributes) {
				return errors.New("successful citation validation requires the complete citation surface")
			}
			return validateContextBriefCitationResultShape(attributes)
		case "context.brief.projection":
			if validationFieldCount != 0 || !hasOutputTruncated {
				return errors.New("successful context brief projection requires only truncation result")
			}
			return nil
		case "context.brief.graph", "context.brief.memory":
			if validationFieldCount != 0 || hasOutputTruncated {
				return errors.New("graph and memory context brief phases cannot include result fields")
			}
			return nil
		default:
			return errors.New("invalid context brief phase")
		}
	}
	if event != "completion" {
		return errors.New("context brief telemetry requires a checkpoint or completion event")
	}
	outcome, _ := anyString(attributes["threadnote.outcome"])
	if outcome != "success" {
		if validationFieldCount != 0 || hasOutputTruncated {
			return errors.New("non-successful context brief completion cannot include result fields")
		}
		return nil
	}
	if phase != "context.brief.projection" || !hasOutputTruncated || !hasCompleteContextBriefCitationSurface(attributes) {
		return errors.New("successful instrumented context brief completion requires the complete result surface")
	}
	return validateContextBriefCitationResultShape(attributes)
}

func validateContextBriefV6AttributeShape(attributes map[string]*commonpb.AnyValue, event, operation string) error {
	phase, hasPhase := anyString(attributes["threadnote.phase"])
	contextPhase := strings.HasPrefix(phase, "context.brief.")
	contextOperation := operation == "context_brief" || operation == "context.brief"
	contextAttributeCount := contextBriefV6AttributeCount(attributes)
	if !contextOperation {
		if contextPhase || contextAttributeCount != 0 {
			return errors.New("context brief attributes require a context brief operation")
		}
		return nil
	}
	if !contextPhase {
		if contextAttributeCount == 0 {
			return nil
		}
		if !hasExactContextBriefRequestSurface(attributes) || contextBriefV6ResultFieldCount(attributes) != 0 {
			return errors.New("context brief telemetry without a phase requires only the request surface")
		}
		_, hasOperationElapsed := anyInt(attributes["threadnote.operation.elapsed_ms"])
		if event == "completion" || (event == "checkpoint" && hasOperationElapsed) {
			return nil
		}
		return errors.New("context brief telemetry requires a closed context brief phase")
	}
	if !hasPhase || !hasExactContextBriefRequestSurface(attributes) {
		return errors.New("context brief telemetry requires scope, contract, and mode")
	}
	contract, _ := anyString(attributes["threadnote.context_brief.contract"])
	resultFieldCount := contextBriefV6ResultFieldCount(attributes)
	if event == "checkpoint" {
		outcome, hasOutcome := anyString(attributes["threadnote.phase.outcome"])
		if !hasOutcome {
			return errors.New("context brief checkpoint requires phase outcome")
		}
		if outcome != "success" {
			if resultFieldCount != 0 {
				return errors.New("non-successful context brief checkpoint cannot include result fields")
			}
			return nil
		}
		switch phase {
		case "context.brief.citation-validation":
			if resultFieldCount != contextBriefCitationValidationFieldCount(attributes) || !hasCompleteContextBriefCitationSurface(attributes) {
				return errors.New("successful citation validation requires only the complete citation surface")
			}
			return validateContextBriefCitationResultShape(attributes)
		case "context.brief.projection":
			expectedProjectionFields := 2
			if contract == "code-anchored-v3" {
				expectedProjectionFields = 9
			}
			if resultFieldCount != expectedProjectionFields {
				return errors.New("successful context brief projection requires only the complete projection surface")
			}
			return validateContextBriefV6ProjectionShape(attributes, contract)
		case "context.brief.code-linked-memory":
			if contract != "code-anchored-v3" || resultFieldCount != 0 {
				return errors.New("code-linked memory phase requires the anchored contract and no result fields")
			}
			return nil
		case "context.brief.graph", "context.brief.memory":
			if resultFieldCount != 0 {
				return errors.New("graph and memory context brief phases cannot include result fields")
			}
			return nil
		default:
			return errors.New("invalid context brief phase")
		}
	}
	if event != "completion" {
		return errors.New("context brief telemetry requires a checkpoint or completion event")
	}
	outcome, _ := anyString(attributes["threadnote.outcome"])
	if outcome != "success" {
		if resultFieldCount != 0 {
			return errors.New("non-successful context brief completion cannot include result fields")
		}
		return nil
	}
	if phase != "context.brief.projection" || !hasCompleteContextBriefCitationSurface(attributes) {
		return errors.New("successful instrumented context brief completion requires citation and projection results")
	}
	if err := validateContextBriefCitationResultShape(attributes); err != nil {
		return err
	}
	return validateContextBriefV6ProjectionShape(attributes, contract)
}

func contextBriefV6AttributeCount(attributes map[string]*commonpb.AnyValue) int {
	count := 0
	for key := range contextBriefRegistrySpanAttributes {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	for _, key := range append(append([]string{}, contextBriefCitationBucketAttributes...), contextBriefCodeAnchorBucketAttributes...) {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	for _, key := range []string{
		"threadnote.context_brief.code_anchor_gap",
		"threadnote.context_brief.output_truncated",
		"threadnote.context_brief.recovery_present",
	} {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	return count
}

func contextBriefV6ResultFieldCount(attributes map[string]*commonpb.AnyValue) int {
	count := contextBriefCitationValidationFieldCount(attributes)
	for _, key := range []string{
		"threadnote.context_brief.code_anchor_coverage",
		"threadnote.context_brief.code_anchor_gap",
		"threadnote.context_brief.code_anchors_matched_memories_bucket",
		"threadnote.context_brief.code_anchors_requested_bucket",
		"threadnote.context_brief.code_anchors_resolved_bucket",
		"threadnote.context_brief.gap_class",
		"threadnote.context_brief.output_truncated",
		"threadnote.context_brief.recovery_present",
		"threadnote.context_brief.returned_lane",
	} {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	return count
}

func hasExactContextBriefRequestSurface(attributes map[string]*commonpb.AnyValue) bool {
	for _, key := range []string{
		"threadnote.context_brief.contract",
		"threadnote.context_brief.mode",
		"threadnote.context_brief.scope",
	} {
		if _, exists := attributes[key]; !exists {
			return false
		}
	}
	return true
}

func validateContextBriefV6ProjectionShape(attributes map[string]*commonpb.AnyValue, contract string) error {
	_, hasOutputTruncated := attributes["threadnote.context_brief.output_truncated"]
	_, hasReturnedLane := attributes["threadnote.context_brief.returned_lane"]
	if !hasOutputTruncated || !hasReturnedLane {
		return errors.New("successful context brief projection requires truncation and returned-lane results")
	}
	anchorFields := contextBriefCodeAnchorFieldCount(attributes)
	if contract == "task-only-v2" {
		if anchorFields != 0 {
			return errors.New("task-only context brief cannot include code-anchor results")
		}
		return nil
	}
	if contract != "code-anchored-v3" || anchorFields != 7 {
		return errors.New("anchored context brief requires the complete code-anchor result surface")
	}
	return validateContextBriefCodeAnchorResultShape(attributes)
}

func contextBriefCodeAnchorFieldCount(attributes map[string]*commonpb.AnyValue) int {
	count := 0
	for _, key := range []string{
		"threadnote.context_brief.code_anchor_coverage",
		"threadnote.context_brief.code_anchor_gap",
		"threadnote.context_brief.code_anchors_matched_memories_bucket",
		"threadnote.context_brief.code_anchors_requested_bucket",
		"threadnote.context_brief.code_anchors_resolved_bucket",
		"threadnote.context_brief.gap_class",
		"threadnote.context_brief.recovery_present",
	} {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	return count
}

func validateContextBriefCodeAnchorResultShape(attributes map[string]*commonpb.AnyValue) error {
	coverage, _ := anyString(attributes["threadnote.context_brief.code_anchor_coverage"])
	gapClass, _ := anyString(attributes["threadnote.context_brief.gap_class"])
	gap, hasGap := anyBool(attributes["threadnote.context_brief.code_anchor_gap"])
	truncated, hasTruncated := anyBool(attributes["threadnote.context_brief.output_truncated"])
	requested := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.code_anchors_requested_bucket")
	resolved := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.code_anchors_resolved_bucket")
	if !hasGap || !hasTruncated || requested < 0 || resolved > requested {
		return errors.New("invalid context brief code-anchor counts or booleans")
	}
	if gap != (gapClass != "none") {
		return errors.New("context brief gap boolean must match the gap class")
	}
	switch coverage {
	case "complete":
		if resolved != requested || gapClass == "unresolved" {
			return errors.New("invalid complete code-anchor coverage")
		}
	case "partial":
		if !gap || (gapClass != "unresolved" && gapClass != "mixed") {
			return errors.New("invalid partial code-anchor coverage")
		}
	case "unavailable":
		if !gap || resolved >= 0 || (gapClass != "unavailable" && gapClass != "mixed") {
			return errors.New("invalid unavailable code-anchor coverage")
		}
	}
	if truncated && gapClass != "truncated" && gapClass != "mixed" {
		return errors.New("context brief gap class must match output truncation")
	}
	return nil
}

func validateCodeAnchorFinalizationAttributeShape(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema, event, operation string) error {
	phase, _ := anyString(attributes["threadnote.phase"])
	attributeCount := 0
	for key := range codeAnchorFinalizationRegistrySpanAttributes {
		if _, exists := attributes[key]; exists {
			attributeCount++
		}
	}
	for _, key := range codeAnchorFinalizationBucketAttributes {
		if _, exists := attributes[key]; exists {
			attributeCount++
		}
	}
	if phase != "memory.code-anchor-finalization" {
		if attributeCount != 0 {
			return errors.New("code anchor finalization attributes require the finalization phase")
		}
		return nil
	}
	if schema.SchemaVersion < 6 || event != "checkpoint" {
		return errors.New("code anchor finalization telemetry requires a schema-v6 checkpoint")
	}
	trigger, hasTrigger := anyString(attributes["threadnote.code_anchor_finalization.trigger"])
	if !hasTrigger {
		return errors.New("code anchor finalization checkpoint requires a trigger")
	}
	explicitOperation := operation == "finalize-code-refs" || operation == "finalize_code_refs"
	if (trigger == "explicit") != explicitOperation {
		return errors.New("code anchor finalization trigger does not match the operation")
	}
	phaseOutcome, hasPhaseOutcome := anyString(attributes["threadnote.phase.outcome"])
	if !hasPhaseOutcome {
		return errors.New("code anchor finalization checkpoint requires phase outcome")
	}
	resultFieldCount := attributeCount - 1
	if phaseOutcome != "success" {
		if resultFieldCount != 0 {
			return errors.New("non-successful code anchor finalization cannot include result fields")
		}
		return nil
	}
	_, hasResult := attributes["threadnote.code_anchor_finalization.result"]
	requiredBuckets := []string{
		"threadnote.code_anchor_finalization.conflict_bucket",
		"threadnote.code_anchor_finalization.failed_bucket",
		"threadnote.code_anchor_finalization.finalized_bucket",
		"threadnote.code_anchor_finalization.latency_ms_bucket",
		"threadnote.code_anchor_finalization.pending_bucket",
		"threadnote.code_anchor_finalization.scanned_bucket",
	}
	for _, key := range requiredBuckets {
		if _, exists := attributes[key]; !exists {
			return errors.New("successful code anchor finalization requires the complete result surface")
		}
	}
	_, hasMatched := attributes["threadnote.code_anchor_finalization.matched_bucket"]
	if !hasResult || hasMatched != (trigger != "explicit") {
		return errors.New("code anchor finalization matched bucket must follow the trigger class")
	}
	if hasMatched && contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.matched_bucket") <
		contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.scanned_bucket") {
		return errors.New("code anchor finalization matched bucket cannot be smaller than scanned")
	}
	return validateCodeAnchorFinalizationResultShape(attributes, trigger)
}

func validateCodeAnchorFinalizationResultShape(attributes map[string]*commonpb.AnyValue, trigger string) error {
	result, _ := anyString(attributes["threadnote.code_anchor_finalization.result"])
	scanned := contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.scanned_bucket")
	finalized := contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.finalized_bucket")
	pending := contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.pending_bucket")
	conflict := contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.conflict_bucket")
	failed := contextBriefBucketOrdinal(attributes, "threadnote.code_anchor_finalization.failed_bucket")
	for _, value := range []int{finalized, pending, conflict, failed} {
		if value > scanned {
			return errors.New("code anchor finalization result bucket cannot exceed scanned")
		}
	}
	nonzero := 0
	for _, value := range []int{finalized, pending, conflict, failed} {
		if value >= 0 {
			nonzero++
		}
	}
	switch result {
	case "no-work":
		if scanned >= 0 || nonzero != 0 {
			return errors.New("no-work finalization requires zero work buckets")
		}
	case "finalized":
		if finalized < 0 || nonzero != 1 {
			return errors.New("finalized result requires only finalized work")
		}
	case "pending":
		if pending < 0 || nonzero != 1 {
			return errors.New("pending result requires only pending work")
		}
	case "conflict":
		if conflict < 0 || nonzero != 1 {
			return errors.New("conflict result requires only conflict work")
		}
	case "failed":
		operationFailedBeforeScanning := scanned < 0 && nonzero == 0
		if operationFailedBeforeScanning && trigger == "explicit" {
			return errors.New("explicit finalization cannot report a failed result before scanning")
		}
		if !operationFailedBeforeScanning && (failed < 0 || nonzero != 1) {
			return errors.New("failed result requires only failed work")
		}
	case "mixed":
		if nonzero < 2 {
			return errors.New("mixed result requires multiple work classes")
		}
	case "contended":
		if trigger == "explicit" {
			return errors.New("explicit finalization cannot report contention")
		}
		return nil
	}
	return nil
}

func contextBriefCitationValidationFieldCount(attributes map[string]*commonpb.AnyValue) int {
	count := 0
	for _, key := range []string{
		"threadnote.context_brief.citation_coverage",
		"threadnote.context_brief.citation_result",
		"threadnote.context_brief.citation_unknown_reason",
	} {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	for _, key := range contextBriefCitationBucketAttributes {
		if _, exists := attributes[key]; exists {
			count++
		}
	}
	return count
}

func hasCompleteContextBriefCitationSurface(attributes map[string]*commonpb.AnyValue) bool {
	for _, key := range []string{
		"threadnote.context_brief.citation_coverage",
		"threadnote.context_brief.citation_result",
	} {
		if _, exists := attributes[key]; !exists {
			return false
		}
	}
	for _, key := range contextBriefCitationBucketAttributes {
		if _, exists := attributes[key]; !exists {
			return false
		}
	}
	return true
}

func validateContextBriefCitationResultShape(attributes map[string]*commonpb.AnyValue) error {
	coverage, _ := anyString(attributes["threadnote.context_brief.citation_coverage"])
	result, _ := anyString(attributes["threadnote.context_brief.citation_result"])
	_, hasUnknownReason := attributes["threadnote.context_brief.citation_unknown_reason"]
	requiresUnknownReason := result == "unknown" || result == "mixed"
	if hasUnknownReason != requiresUnknownReason {
		return errors.New("context brief unknown reason must match the citation result")
	}
	citations := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.citations_bucket")
	exact := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.exact_citations_bucket")
	relocated := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.relocated_citations_bucket")
	stale := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.stale_citations_bucket")
	unknown := contextBriefBucketOrdinal(attributes, "threadnote.context_brief.unknown_citations_bucket")
	for _, key := range []string{
		"threadnote.context_brief.cache_hits_bucket",
		"threadnote.context_brief.cited_memories_bucket",
		"threadnote.context_brief.exact_citations_bucket",
		"threadnote.context_brief.relocated_citations_bucket",
		"threadnote.context_brief.repositories_validated_bucket",
		"threadnote.context_brief.stale_citations_bucket",
		"threadnote.context_brief.unknown_citations_bucket",
	} {
		if contextBriefBucketOrdinal(attributes, key) > citations {
			return errors.New("context brief work bucket cannot exceed the citation bucket")
		}
	}
	if (citations < 0) != (coverage == "none") || (citations < 0) != (result == "none") {
		return errors.New("empty context brief citations require none coverage and result")
	}
	switch coverage {
	case "complete":
		if unknown >= 0 {
			return errors.New("complete context brief coverage cannot include unknown citations")
		}
	case "partial":
		if unknown < 0 || (exact < 0 && relocated < 0 && stale < 0) {
			return errors.New("partial context brief coverage requires known and unknown citations")
		}
	case "unavailable":
		if unknown != citations || exact >= 0 || relocated >= 0 || stale >= 0 {
			return errors.New("unavailable context brief coverage requires only unknown citations")
		}
	}
	switch result {
	case "exact-only":
		if coverage != "complete" || exact < 0 || relocated >= 0 || stale >= 0 || unknown >= 0 {
			return errors.New("invalid exact-only context brief result")
		}
	case "relocated":
		if coverage != "complete" || relocated < 0 || stale >= 0 || unknown >= 0 {
			return errors.New("invalid relocated context brief result")
		}
	case "stale":
		if coverage != "complete" || stale < 0 || unknown >= 0 {
			return errors.New("invalid stale context brief result")
		}
	case "unknown":
		if (coverage != "partial" && coverage != "unavailable") || stale >= 0 || unknown < 0 {
			return errors.New("invalid unknown context brief result")
		}
	case "mixed":
		if coverage != "partial" || stale < 0 || unknown < 0 {
			return errors.New("invalid mixed context brief result")
		}
	}
	return nil
}

func contextBriefBucketOrdinal(attributes map[string]*commonpb.AnyValue, key string) int {
	value, _ := anyString(attributes[key])
	if value == "0" {
		return -1
	}
	exponent, err := strconv.Atoi(strings.TrimPrefix(value, "2^"))
	if err != nil {
		return -1
	}
	return exponent
}

func validateGraphQueryAttributeShape(attributes map[string]*commonpb.AnyValue, schema *compiledTelemetrySchema, event, operation string) error {
	phase, hasPhase := anyString(attributes["threadnote.phase"])
	queryPhase := strings.HasPrefix(phase, "graph.query.")
	stage, _ := anyString(attributes["threadnote.stage"])
	subphase, hasSubphase := anyString(attributes["threadnote.subphase"])
	queryStage := strings.HasPrefix(stage, "query-")
	querySubphase := subphase == "skipped" || subphase == "fallback"
	requestKind, hasRequestKind := anyString(attributes["threadnote.graph.request_kind"])
	requestScope, hasRequestScope := anyString(attributes["threadnote.graph.request_scope"])
	queryAttributeCount := 0
	for key := range graphQueryRegistrySpanAttributes {
		if _, exists := attributes[key]; exists {
			queryAttributeCount++
		}
	}
	for _, key := range graphQuerySnapshotBucketAttributes {
		if _, exists := attributes[key]; exists {
			queryAttributeCount++
		}
	}

	requestKindPrefix := ""
	switch operation {
	case "inspect_code_graph":
		requestKindPrefix = "inspect."
	case "analyze_code_graph":
		requestKindPrefix = "analyze."
	}
	if requestKindPrefix == "" {
		if queryPhase || queryAttributeCount != 0 || queryStage || querySubphase {
			return errors.New("graph query attributes require a graph query operation")
		}
		return nil
	}
	if schema.SchemaVersion < 4 {
		return nil
	}
	if !queryPhase && queryAttributeCount == 0 && !queryStage && !querySubphase {
		return nil
	}
	if !hasRequestKind || !hasRequestScope || !strings.HasPrefix(requestKind, requestKindPrefix) {
		return errors.New("graph query operation requires matching request kind and scope")
	}
	if querySubphase && !queryStage {
		return errors.New("graph query skipped or fallback subphase requires a query stage")
	}
	if queryStage {
		if event != "checkpoint" {
			return errors.New("graph query stage requires a checkpoint event")
		}
		if hasSubphase && !querySubphase {
			return errors.New("graph query stage permits only skipped or fallback subphases")
		}
		if !hasPhase || (phase != "graph.query.status" && phase != "graph.query.snapshot" && phase != "graph.query.execute") {
			return errors.New("graph query stage checkpoint requires an admitted graph query phase")
		}
		phaseOutcome, hasPhaseOutcome := anyString(attributes["threadnote.phase.outcome"])
		if !hasPhaseOutcome {
			return errors.New("graph query stage checkpoint requires a phase outcome")
		}
		if outcome, hasOutcome := anyString(attributes["threadnote.outcome"]); hasOutcome && outcome != phaseOutcome {
			return errors.New("graph query stage checkpoint outcomes must agree")
		}
		if subphase == "skipped" && phaseOutcome != "success" {
			return errors.New("skipped graph query stage checkpoint requires a success outcome")
		}
		if _, hasPhaseElapsed := anyInt(attributes["threadnote.phase.elapsed_ms"]); !hasPhaseElapsed {
			return errors.New("graph query stage checkpoint requires phase elapsed time")
		}
		snapshotAttributeCount, _ := graphQuerySnapshotAttributeCounts(attributes)
		if snapshotAttributeCount != 0 {
			return errors.New("graph query stage checkpoint cannot include a snapshot surface")
		}
		if requestScope != "local" && requestScope != "workset" {
			return errors.New("invalid graph query request scope")
		}
		return nil
	}
	if event == "checkpoint" {
		if !hasPhase {
			_, hasOperationElapsed := anyInt(attributes["threadnote.operation.elapsed_ms"])
			if queryAttributeCount != 2 || !hasOperationElapsed {
				return errors.New("phase-less graph query checkpoint requires only request kind, scope, and operation elapsed time")
			}
			return nil
		}
		if phase != "graph.query.status" && phase != "graph.query.snapshot" && phase != "graph.query.execute" {
			return errors.New("graph query checkpoint requires an admitted graph query phase")
		}
	} else if event == "completion" {
		if hasPhase && phase != "graph.query.execute" {
			return errors.New("graph query completion can include only the execute phase")
		}
	} else {
		return errors.New("graph query operation requires a checkpoint or completion event")
	}

	snapshotAttributeCount, snapshotBucketCount := graphQuerySnapshotAttributeCounts(attributes)
	if requestScope == "workset" {
		if snapshotAttributeCount != 0 {
			return errors.New("workset graph query telemetry cannot include a local snapshot surface")
		}
		return nil
	}
	if requestScope != "local" {
		return errors.New("invalid graph query request scope")
	}

	phaseOutcome, _ := anyString(attributes["threadnote.phase.outcome"])
	requiresSnapshotSurface := event == "checkpoint" && phaseOutcome == "success" && (phase == "graph.query.snapshot" || phase == "graph.query.execute")
	if event == "completion" {
		outcome, _ := anyString(attributes["threadnote.outcome"])
		requiresSnapshotSurface = outcome == "success"
	}
	if event == "checkpoint" && phase == "graph.query.status" && snapshotAttributeCount != 0 {
		return errors.New("graph query status checkpoint cannot include a snapshot surface")
	}
	if !requiresSnapshotSurface {
		if snapshotAttributeCount != 0 {
			return errors.New("non-successful graph query telemetry cannot include a snapshot surface")
		}
		return nil
	}
	selection, hasSelection := anyString(attributes["threadnote.graph.snapshot_selection"])
	if !hasSelection {
		return errors.New("local graph query telemetry requires snapshot selection")
	}
	if selection == "none" {
		if snapshotBucketCount != 0 || snapshotAttributeCount != 1 {
			return errors.New("snapshot selection none forbids freshness and published snapshot buckets")
		}
		return nil
	}
	_, hasFreshness := anyString(attributes["threadnote.graph.snapshot_freshness"])
	if !hasFreshness {
		return errors.New("selected published snapshot requires freshness")
	}
	if snapshotBucketCount != len(graphQuerySnapshotBucketAttributes) || snapshotAttributeCount != 2+len(graphQuerySnapshotBucketAttributes) {
		return errors.New("selected published snapshot requires complete file, symbol, and edge buckets")
	}
	return nil
}

func graphQuerySnapshotAttributeCounts(attributes map[string]*commonpb.AnyValue) (total, buckets int) {
	for _, key := range []string{"threadnote.graph.snapshot_selection", "threadnote.graph.snapshot_freshness"} {
		if _, exists := attributes[key]; exists {
			total++
		}
	}
	for _, key := range graphQuerySnapshotBucketAttributes {
		if _, exists := attributes[key]; exists {
			total++
			buckets++
		}
	}
	return total, buckets
}

func memoryGroups(attributes map[string]*commonpb.AnyValue) (current, start, end int) {
	for key := range attributes {
		if len(key) < len("threadnote.memory.") || key[:len("threadnote.memory.")] != "threadnote.memory." {
			continue
		}
		switch {
		case len(key) >= len(".current_bucket") && key[len(key)-len(".current_bucket"):] == ".current_bucket":
			current++
		case len(key) >= len(".start_bucket") && key[len(key)-len(".start_bucket"):] == ".start_bucket":
			start++
		case len(key) >= len(".end_bucket") && key[len(key)-len(".end_bucket"):] == ".end_bucket":
			end++
		}
	}
	return
}

func nonzeroID(value []byte, length int) bool {
	if len(value) != length {
		return false
	}
	for _, b := range value {
		if b != 0 {
			return true
		}
	}
	return false
}
func contains(values map[string]struct{}, value string) bool { _, ok := values[value]; return ok }
func anyString(value *commonpb.AnyValue) (string, bool) {
	if value == nil {
		return "", false
	}
	typed, ok := value.Value.(*commonpb.AnyValue_StringValue)
	if !ok {
		return "", false
	}
	return typed.StringValue, true
}
func anyBool(value *commonpb.AnyValue) (bool, bool) {
	if value == nil {
		return false, false
	}
	typed, ok := value.Value.(*commonpb.AnyValue_BoolValue)
	if !ok {
		return false, false
	}
	return typed.BoolValue, true
}
func anyInt(value *commonpb.AnyValue) (int64, bool) {
	if value == nil {
		return 0, false
	}
	typed, ok := value.Value.(*commonpb.AnyValue_IntValue)
	if !ok {
		return 0, false
	}
	return typed.IntValue, true
}
func valueStringIn(value *commonpb.AnyValue, values map[string]struct{}) bool {
	text, ok := anyString(value)
	return ok && contains(values, text)
}
func valueStringMatches(value *commonpb.AnyValue, pattern *regexp.Regexp) bool {
	text, ok := anyString(value)
	return ok && pattern.MatchString(text)
}
func valueStringMatchesBounded(value *commonpb.AnyValue, pattern *regexp.Regexp, maxBytes int) bool {
	text, ok := anyString(value)
	return ok && len(text) <= maxBytes && pattern.MatchString(text)
}
func stringAttributeEquals(values map[string]*commonpb.AnyValue, key, expected string) bool {
	text, ok := anyString(values[key])
	return ok && text == expected
}
func stringAttributeMatches(values map[string]*commonpb.AnyValue, key string, pattern *regexp.Regexp) bool {
	return valueStringMatches(values[key], pattern)
}
func stringAttributeMatchesBounded(values map[string]*commonpb.AnyValue, key string, pattern *regexp.Regexp, maxBytes int) bool {
	return valueStringMatchesBounded(values[key], pattern, maxBytes)
}
func stringAttributeIn(values map[string]*commonpb.AnyValue, key string, registry map[string]struct{}) bool {
	return valueStringIn(values[key], registry)
}
func intAttributeEquals(values map[string]*commonpb.AnyValue, key string, expected int64) bool {
	value, ok := anyInt(values[key])
	return ok && value == expected
}
