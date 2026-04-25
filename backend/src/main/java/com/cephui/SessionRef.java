package com.cephui;

import software.amazon.awssdk.services.s3.S3Client;

public record SessionRef(String sessionId, S3Client client) {
}
