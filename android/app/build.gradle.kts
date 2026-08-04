import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.touchdeck.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.touchdeck.app"
        minSdk = 26
        targetSdk = 34
versionCode = 4
versionName = "0.1.6"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // WebRTC（P2P 直连打洞）
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    // WebSocket（信令）
    implementation("org.java-websocket:Java-WebSocket:1.5.6")
}
