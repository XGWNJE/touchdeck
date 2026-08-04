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
        versionCode = 2
        versionName = "0.1.1-fill"
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
