package com.cephui;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;

import java.net.URI;

public final class S3ClientFactory {
    private S3ClientFactory() {
    }

    public static S3Client create(App.ConnectRequest request) {
        String region = request.region() == null || request.region().isBlank() ? "us-east-1" : request.region();
        boolean pathStyle = request.pathStyle();

        return S3Client.builder()
            .endpointOverride(URI.create(request.endpoint()))
            .region(Region.of(region))
            .credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(request.accessKey(), request.secretKey())
            ))
            .serviceConfiguration(S3Configuration.builder()
                .pathStyleAccessEnabled(pathStyle)
                .build())
            .build();
    }
}
