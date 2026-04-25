FROM maven:3.9.8-eclipse-temurin-17 AS build
WORKDIR /app

COPY backend/pom.xml backend/pom.xml
RUN mvn -q -f backend/pom.xml -DskipTests dependency:go-offline

COPY backend backend
COPY frontend/public backend/src/main/resources/public

RUN mvn -q -f backend/pom.xml -DskipTests package

FROM eclipse-temurin:17-jre
WORKDIR /opt/ceph-ui

COPY --from=build /app/backend/target/ceph-ui.jar /opt/ceph-ui/ceph-ui.jar

EXPOSE 8080
ENV PORT=8080

ENTRYPOINT ["java", "-jar", "/opt/ceph-ui/ceph-ui.jar"]
