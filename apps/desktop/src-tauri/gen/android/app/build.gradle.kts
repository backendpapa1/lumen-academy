import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing (ADR-012): the keystore lives outside the repo. Its settings
// (storeFile, storePassword, keyAlias, keyPassword) come from a gitignored
// keystore.properties next to this project, else ~/.config/lumen-android/
// keystore.properties; LUMEN_KEYSTORE_* env vars override either.
val signing = Properties().apply {
    val f = listOf(
        rootProject.file("keystore.properties"),
        file("${System.getProperty("user.home")}/.config/lumen-android/keystore.properties"),
    ).firstOrNull { it.exists() }
    f?.inputStream()?.use { load(it) }
    System.getenv("LUMEN_KEYSTORE")?.let { setProperty("storeFile", it) }
    System.getenv("LUMEN_KEYSTORE_PASSWORD")?.let { setProperty("storePassword", it) }
    System.getenv("LUMEN_KEY_ALIAS")?.let { setProperty("keyAlias", it) }
    System.getenv("LUMEN_KEY_PASSWORD")?.let { setProperty("keyPassword", it) }
}

android {
    compileSdk = 36
    namespace = "academy.lumen.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "academy.lumen.app"
        // Android 10+: the W^X rules the runtime is built around (ADR-012).
        minSdk = 29
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // Node and glibc are linux-arm64 builds: 64-bit ARM phones only.
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    packaging {
        // The loader and the supervisor must be extracted to the native library
        // dir as real files: they're the only programs the app may exec.
        jniLibs.useLegacyPackaging = true
    }
    androidResources {
        // Stored as is: it's already xz, and an uncompressed asset can be measured
        // for the unpacking progress bar.
        noCompress += listOf("xz")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // Unpacks lumen-runtime.tar.xz (pure Java, 2024).
    implementation("org.tukaani:xz:1.10")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
