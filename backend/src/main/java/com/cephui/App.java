package com.cephui;

import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.staticfiles.Location;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.model.Bucket;
import software.amazon.awssdk.services.s3.model.CommonPrefix;
import software.amazon.awssdk.services.s3.model.GetObjectTaggingRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.GetBucketLifecycleConfigurationRequest;
import software.amazon.awssdk.services.s3.model.GetBucketPolicyRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.LifecycleRule;
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.S3Object;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.Tag;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

public final class App {
    private static final int DEFAULT_PORT = 8080;
    private static final int DEFAULT_MAX_KEYS = 1000;
    private static final int MAX_ALLOWED_KEYS = 1000;
    private static final int DEFAULT_SEARCH_MAX_KEYS = 200;
    private static final int MAX_SEARCH_SCAN_LIMIT = 5000;
    private static final int DEFAULT_PREVIEW_MAX_BYTES = 262_144;
    private static final int MAX_PREVIEW_BYTES = 1_048_576;
    private static final Duration SESSION_TTL = Duration.ofMinutes(30);

    private App() {
    }

    public static void main(String[] args) {
        SessionStore sessions = new SessionStore(SESSION_TTL);

        Javalin app = Javalin.create(config -> {
            config.staticFiles.add(staticFiles -> {
                staticFiles.directory = "/public";
                staticFiles.location = Location.CLASSPATH;
            });
            config.http.defaultContentType = "application/json";
        });

        app.post("/api/connect", ctx -> {
            ConnectRequest request = ctx.bodyAsClass(ConnectRequest.class);
            validateConnectRequest(request);
            String sessionId = sessions.create(request);
            try {
                SessionRef session = sessions.get(sessionId);
                if (session == null) {
                    throw new IllegalArgumentException("Failed to initialize session");
                }
                int bucketCount = session.client().listBuckets().buckets().size();
                ctx.json(Map.of("sessionId", sessionId, "verified", true, "bucketCount", bucketCount));
            } catch (RuntimeException ex) {
                sessions.invalidate(sessionId);
                throw ex;
            }
        });

        app.get("/api/buckets", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            List<BucketView> buckets = session.client()
                .listBuckets()
                .buckets()
                .stream()
                .map(BucketView::from)
                .toList();
            ctx.json(Map.of("buckets", buckets));
        });

        app.get("/api/objects", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            String prefix = ctx.queryParam("prefix");
            if (prefix == null) {
                prefix = "";
            }
            String continuationToken = ctx.queryParam("continuationToken");
            int maxKeys = clampMaxKeys(ctx.queryParamAsClass("maxKeys", Integer.class).getOrDefault(DEFAULT_MAX_KEYS));

            ListObjectsV2Request.Builder requestBuilder = ListObjectsV2Request.builder()
                .bucket(bucket)
                .prefix(prefix)
                .delimiter("/")
                .maxKeys(maxKeys);

            if (continuationToken != null && !continuationToken.isBlank()) {
                requestBuilder.continuationToken(continuationToken);
            }

            var response = session.client().listObjectsV2(requestBuilder.build());

            List<String> commonPrefixes = response.commonPrefixes()
                .stream()
                .map(CommonPrefix::prefix)
                .toList();

            List<ObjectSummaryView> objects = response.contents()
                .stream()
                .map(ObjectSummaryView::from)
                .toList();

            ctx.json(new ListObjectsResponse(
                commonPrefixes,
                objects,
                response.nextContinuationToken(),
                response.isTruncated()
            ));
        });

        app.get("/api/object/meta", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            String key = requiredQuery(ctx, "key");

            var response = session.client().headObject(HeadObjectRequest.builder()
                .bucket(bucket)
                .key(key)
                .build());

            Map<String, Object> payload = new HashMap<>();
            payload.put("bucket", bucket);
            payload.put("key", key);
            payload.put("size", response.contentLength());
            payload.put("lastModified", response.lastModified() == null ? null : response.lastModified().toString());
            payload.put("contentType", response.contentType());
            payload.put("etag", response.eTag());
            payload.put("metadata", response.metadata());
            ctx.json(payload);
        });

        app.get("/api/object/tags", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            String key = requiredQuery(ctx, "key");

            var response = session.client().getObjectTagging(GetObjectTaggingRequest.builder()
                .bucket(bucket)
                .key(key)
                .build());

            List<Map<String, String>> tags = response.tagSet()
                .stream()
                .map(App::toTagMap)
                .toList();

            ctx.json(Map.of(
                "bucket", bucket,
                "key", key,
                "tags", tags
            ));
        });

        app.get("/api/object/content", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            String key = requiredQuery(ctx, "key");
            int maxBytes = clampPreviewBytes(ctx.queryParamAsClass("maxBytes", Integer.class).getOrDefault(DEFAULT_PREVIEW_MAX_BYTES));

            HeadObjectResponse head = session.client().headObject(HeadObjectRequest.builder()
                .bucket(bucket)
                .key(key)
                .build());

            long size = head.contentLength() == null ? 0L : head.contentLength();
            String contentType = head.contentType();

            String range = "bytes=0-" + Math.max(0, maxBytes - 1);
            byte[] bytes;
            try (ResponseInputStream<?> stream = session.client().getObject(GetObjectRequest.builder()
                .bucket(bucket)
                .key(key)
                .range(range)
                .build())) {
                bytes = stream.readAllBytes();
            } catch (Exception e) {
                throw new IllegalStateException("Failed to read object preview", e);
            }

            boolean isText = isLikelyText(contentType, bytes);
            String previewText = isText ? new String(bytes, StandardCharsets.UTF_8) : null;
            boolean isTruncated = size > bytes.length;

            Map<String, Object> payload = new HashMap<>();
            payload.put("bucket", bucket);
            payload.put("key", key);
            payload.put("size", size);
            payload.put("contentType", contentType == null ? "application/octet-stream" : contentType);
            payload.put("encoding", isText ? "utf-8" : "binary");
            payload.put("isText", isText);
            payload.put("previewText", previewText);
            payload.put("isTruncated", isTruncated);
            payload.put("maxBytes", maxBytes);
            ctx.json(payload);
        });

        app.get("/api/bucket/lifecycle", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            try {
                var response = session.client().getBucketLifecycleConfiguration(GetBucketLifecycleConfigurationRequest.builder()
                    .bucket(bucket)
                    .build());
                List<Map<String, Object>> rules = response.rules().stream()
                    .map(App::toLifecycleRuleView)
                    .toList();
                ctx.json(Map.of(
                    "status", "configured",
                    "rules", rules
                ));
            } catch (S3Exception e) {
                String code = e.awsErrorDetails() == null ? "" : e.awsErrorDetails().errorCode();
                if ("NoSuchLifecycleConfiguration".equals(code)) {
                    ctx.json(Map.of(
                        "status", "not_configured",
                        "rules", List.of()
                    ));
                } else {
                    throw e;
                }
            }
        });

        app.get("/api/bucket/policy", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            try {
                var response = session.client().getBucketPolicy(GetBucketPolicyRequest.builder()
                    .bucket(bucket)
                    .build());
                Map<String, Object> payload = new HashMap<>();
                payload.put("status", "configured");
                payload.put("policy", response.policy());
                ctx.json(payload);
            } catch (S3Exception e) {
                String code = e.awsErrorDetails() == null ? "" : e.awsErrorDetails().errorCode();
                if ("NoSuchBucketPolicy".equals(code)) {
                    ctx.json(Map.of("status", "not_configured"));
                } else {
                    throw e;
                }
            }
        });

        app.get("/api/search", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            String bucket = requiredQuery(ctx, "bucket");
            String prefix = ctx.queryParam("prefix");
            if (prefix == null) {
                prefix = "";
            }
            String query = requiredQuery(ctx, "query").toLowerCase();
            String continuationToken = ctx.queryParam("continuationToken");
            int maxKeys = clampMaxKeys(ctx.queryParamAsClass("maxKeys", Integer.class).getOrDefault(DEFAULT_SEARCH_MAX_KEYS));

            List<ObjectSummaryView> matches = new ArrayList<>();
            String scanToken = continuationToken;
            int scannedCount = 0;
            boolean scanLimitReached = false;
            boolean hasMore = false;

            while (matches.size() < maxKeys && scannedCount < MAX_SEARCH_SCAN_LIMIT) {
                int remainingScan = MAX_SEARCH_SCAN_LIMIT - scannedCount;
                int pageMax = Math.min(MAX_ALLOWED_KEYS, Math.max(1, remainingScan));
                ListObjectsV2Request.Builder requestBuilder = ListObjectsV2Request.builder()
                    .bucket(bucket)
                    .prefix(prefix)
                    .maxKeys(pageMax);

                if (scanToken != null && !scanToken.isBlank()) {
                    requestBuilder.continuationToken(scanToken);
                }

                var response = session.client().listObjectsV2(requestBuilder.build());
                scannedCount += response.contents().size();

                for (S3Object object : response.contents()) {
                    if (matches.size() >= maxKeys) {
                        break;
                    }
                    if (object.key() != null && object.key().toLowerCase().contains(query)) {
                        matches.add(ObjectSummaryView.from(object));
                    }
                }

                scanToken = response.nextContinuationToken();
                hasMore = response.isTruncated();
                if (!hasMore) {
                    break;
                }
            }

            if (scannedCount >= MAX_SEARCH_SCAN_LIMIT && hasMore) {
                scanLimitReached = true;
            }

            ctx.json(Map.of(
                "objects", matches,
                "nextToken", hasMore ? scanToken : null,
                "isTruncated", hasMore,
                "scannedCount", scannedCount,
                "scanLimitReached", scanLimitReached
            ));
        });

        app.get("/api/health/rgw", ctx -> {
            SessionRef session = getSession(ctx, sessions);
            int bucketCount = session.client().listBuckets().buckets().size();
            ctx.json(Map.of("ok", true, "bucketCount", bucketCount));
        });

        app.exception(IllegalArgumentException.class, (e, ctx) -> ctx.status(400).json(Map.of("error", e.getMessage())));
        app.exception(S3Exception.class, (e, ctx) -> {
            int status = e.statusCode() > 0 ? e.statusCode() : 500;
            String code = e.awsErrorDetails() == null ? "S3Error" : e.awsErrorDetails().errorCode();
            String message = sanitize(e.awsErrorDetails() == null ? e.getMessage() : e.awsErrorDetails().errorMessage());
            Map<String, Object> payload = new HashMap<>();
            payload.put("error", code + ": " + message);
            payload.put("code", code);
            payload.put("status", status);
            if (e.requestId() != null && !e.requestId().isBlank()) {
                payload.put("requestId", e.requestId());
            }
            ctx.status(status).json(payload);
        });
        app.exception(SdkException.class, (e, ctx) -> ctx.status(502).json(Map.of("error", sanitize(e.getMessage()))));
        app.exception(Exception.class, (e, ctx) -> ctx.status(500).json(Map.of("error", "Unexpected server error")));

        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", Integer.toString(DEFAULT_PORT)));
        app.start(port);
    }

    private static Map<String, String> toTagMap(Tag tag) {
        return Map.of("key", tag.key(), "value", tag.value());
    }

    private static Map<String, Object> toLifecycleRuleView(LifecycleRule rule) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", rule.id());
        out.put("status", rule.statusAsString());
        out.put("prefix", rule.prefix());
        if (rule.filter() != null && rule.filter().prefix() != null) {
            out.put("filterPrefix", rule.filter().prefix());
        }
        if (rule.expiration() != null) {
            out.put("expirationDays", rule.expiration().days());
            out.put("expirationDate", rule.expiration().date() == null ? null : rule.expiration().date().toString());
            out.put("expiredObjectDeleteMarker", rule.expiration().expiredObjectDeleteMarker());
        }
        return out;
    }

    private static SessionRef getSession(Context ctx, SessionStore sessions) {
        String sessionId = requiredQuery(ctx, "sessionId");
        SessionRef session = sessions.get(sessionId);
        if (session == null) {
            throw new IllegalArgumentException("Invalid or expired sessionId");
        }
        return session;
    }

    private static String requiredQuery(Context ctx, String name) {
        String value = ctx.queryParam(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing required query parameter: " + name);
        }
        return value;
    }

    private static int clampMaxKeys(int maxKeys) {
        if (maxKeys <= 0) {
            return DEFAULT_MAX_KEYS;
        }
        return Math.min(maxKeys, MAX_ALLOWED_KEYS);
    }

    private static int clampPreviewBytes(int maxBytes) {
        if (maxBytes <= 0) {
            return DEFAULT_PREVIEW_MAX_BYTES;
        }
        return Math.min(maxBytes, MAX_PREVIEW_BYTES);
    }

    private static void validateConnectRequest(ConnectRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Request body is required");
        }
        if (isBlank(request.endpoint())) {
            throw new IllegalArgumentException("endpoint is required");
        }
        validateEndpoint(request.endpoint());
        if (isBlank(request.accessKey())) {
            throw new IllegalArgumentException("accessKey is required");
        }
        if (isBlank(request.secretKey())) {
            throw new IllegalArgumentException("secretKey is required");
        }
    }

    private static void validateEndpoint(String endpoint) {
        URI uri;
        try {
            uri = URI.create(endpoint.trim());
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("endpoint is not a valid URL");
        }

        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new IllegalArgumentException("endpoint must use http:// or https://");
        }
        if (isBlank(uri.getHost())) {
            throw new IllegalArgumentException("endpoint host is required");
        }
        String path = uri.getPath();
        if (path != null && !path.isBlank() && !"/".equals(path)) {
            throw new IllegalArgumentException("endpoint must not include a path. Example: http://localhost:7480");
        }
        if (uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("endpoint must not include query or fragment");
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String sanitize(String value) {
        if (value == null) {
            return "Upstream S3 error";
        }
        return value
            .replaceAll("(?i)secret(access)?key\\s*[:=]\\s*[^,\\s]+", "secretKey=***")
            .replaceAll("(?i)accesskey\\s*[:=]\\s*[^,\\s]+", "accessKey=***");
    }

    private static boolean isLikelyText(String contentType, byte[] bytes) {
        if (contentType != null) {
            String normalized = contentType.toLowerCase();
            if (normalized.startsWith("text/")) {
                return true;
            }
            if (normalized.contains("json")
                || normalized.contains("xml")
                || normalized.contains("yaml")
                || normalized.contains("csv")
                || normalized.contains("javascript")) {
                return true;
            }
        }

        int sampleSize = Math.min(bytes.length, 2048);
        int suspicious = 0;
        for (int i = 0; i < sampleSize; i++) {
            int b = bytes[i] & 0xFF;
            if (b == 0) {
                return false;
            }
            boolean printable = b == 9 || b == 10 || b == 13 || (b >= 32 && b < 127) || b >= 160;
            if (!printable) {
                suspicious++;
            }
        }
        return suspicious <= Math.max(1, sampleSize / 40);
    }

    public record ConnectRequest(String endpoint, String accessKey, String secretKey, String region, boolean pathStyle) {
    }

    public record BucketView(String name, String creationDate) {
        static BucketView from(Bucket bucket) {
            return new BucketView(bucket.name(), bucket.creationDate() == null ? null : bucket.creationDate().toString());
        }
    }

    public record ObjectSummaryView(String key, long size, String lastModified, String etag, String storageClass) {
        static ObjectSummaryView from(S3Object object) {
            return new ObjectSummaryView(
                object.key(),
                object.size() == null ? 0 : object.size(),
                object.lastModified() == null ? null : object.lastModified().toString(),
                object.eTag(),
                object.storageClass() == null ? null : object.storageClassAsString()
            );
        }
    }

    public record ListObjectsResponse(List<String> commonPrefixes, List<ObjectSummaryView> objects, String nextToken, boolean isTruncated) {
    }
}
