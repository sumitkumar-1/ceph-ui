package com.cephui;

import software.amazon.awssdk.services.s3.S3Client;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class SessionStore {
    private final Duration ttl;
    private final Map<String, SessionEntry> sessions = new ConcurrentHashMap<>();

    public SessionStore(Duration ttl) {
        this.ttl = ttl;
    }

    public String create(App.ConnectRequest request) {
        cleanupExpired();
        String sessionId = UUID.randomUUID().toString();
        S3Client client = S3ClientFactory.create(request);
        sessions.put(sessionId, new SessionEntry(client, Instant.now().plus(ttl)));
        return sessionId;
    }

    public SessionRef get(String sessionId) {
        SessionEntry entry = sessions.get(sessionId);
        if (entry == null) {
            return null;
        }
        if (Instant.now().isAfter(entry.expiresAt())) {
            sessions.remove(sessionId);
            closeQuietly(entry.client());
            return null;
        }

        Instant newExpiry = Instant.now().plus(ttl);
        sessions.put(sessionId, new SessionEntry(entry.client(), newExpiry));
        return new SessionRef(sessionId, entry.client());
    }

    public void invalidate(String sessionId) {
        SessionEntry removed = sessions.remove(sessionId);
        if (removed != null) {
            closeQuietly(removed.client());
        }
    }

    private void cleanupExpired() {
        Instant now = Instant.now();
        sessions.entrySet().removeIf(entry -> {
            boolean expired = now.isAfter(entry.getValue().expiresAt());
            if (expired) {
                closeQuietly(entry.getValue().client());
            }
            return expired;
        });
    }

    private static void closeQuietly(S3Client client) {
        try {
            client.close();
        } catch (Exception ignored) {
            // Best-effort cleanup.
        }
    }

    private record SessionEntry(S3Client client, Instant expiresAt) {
    }
}
