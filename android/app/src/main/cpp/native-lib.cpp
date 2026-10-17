// JNI bridge between the Android app and the embedded Node.js runtime (nodejs-mobile).
//
// Starts node::Start() on a dedicated thread, mirrors stdout/stderr to logcat and to a log
// file the app can show, and reports back to Java when Node.js exits.
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "node.h"

namespace {

constexpr const char *kLogTag = "SillyTavern-Node";
constexpr size_t kNodeThreadStackSize = 8 * 1024 * 1024;
constexpr long kMaxLogFileBytes = 8 * 1024 * 1024;

std::atomic<bool> g_started(false);
JavaVM *g_vm = nullptr;
jclass g_bridge_class = nullptr;
jmethodID g_on_exit = nullptr;

std::mutex g_log_mutex;
FILE *g_log_file = nullptr;
std::string g_log_path;

struct NodeArgs {
    int argc;
    char **argv;
};

void WriteToLogFile(const char *data, size_t length) {
    std::lock_guard<std::mutex> lock(g_log_mutex);
    if (g_log_file == nullptr) {
        return;
    }
    // Keep the file bounded: start over when it gets too big
    if (ftell(g_log_file) > kMaxLogFileBytes) {
        FILE *reopened = freopen(g_log_path.c_str(), "w", g_log_file);
        if (reopened == nullptr) {
            g_log_file = nullptr;
            return;
        }
        g_log_file = reopened;
        const char *notice = "[log truncated]\n";
        fwrite(notice, 1, strlen(notice), g_log_file);
    }
    fwrite(data, 1, length, g_log_file);
    fflush(g_log_file);
}

struct PipeReader {
    int fd;
    int priority;
};

void *ReadPipe(void *arg) {
    PipeReader reader = *static_cast<PipeReader *>(arg);
    delete static_cast<PipeReader *>(arg);
    char buffer[4096];
    ssize_t size;
    while ((size = read(reader.fd, buffer, sizeof(buffer) - 1)) > 0) {
        WriteToLogFile(buffer, static_cast<size_t>(size));
        if (buffer[size - 1] == '\n') {
            size--;
        }
        buffer[size] = '\0';
        __android_log_write(reader.priority, kLogTag, buffer);
    }
    return nullptr;
}

bool StartPipeReader(int target_fd, int priority) {
    int fds[2];
    if (pipe(fds) != 0) {
        return false;
    }
    if (dup2(fds[1], target_fd) < 0) {
        close(fds[0]);
        close(fds[1]);
        return false;
    }
    close(fds[1]);
    pthread_t thread;
    auto *reader = new PipeReader{fds[0], priority};
    if (pthread_create(&thread, nullptr, ReadPipe, reader) != 0) {
        delete reader;
        return false;
    }
    pthread_detach(thread);
    return true;
}

void RedirectOutput(const char *log_path) {
    {
        std::lock_guard<std::mutex> lock(g_log_mutex);
        g_log_path = log_path;
        g_log_file = fopen(log_path, "w");
    }
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (!StartPipeReader(STDOUT_FILENO, ANDROID_LOG_INFO) || !StartPipeReader(STDERR_FILENO, ANDROID_LOG_ERROR)) {
        __android_log_write(ANDROID_LOG_WARN, kLogTag, "Could not redirect Node.js output");
    }
}

void NotifyExit(int exit_code) {
    if (g_vm == nullptr || g_bridge_class == nullptr || g_on_exit == nullptr) {
        return;
    }
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
            return;
        }
        attached = true;
    }
    env->CallStaticVoidMethod(g_bridge_class, g_on_exit, static_cast<jint>(exit_code));
    if (env->ExceptionCheck()) {
        env->ExceptionDescribe();
        env->ExceptionClear();
    }
    if (attached) {
        g_vm->DetachCurrentThread();
    }
}

void *RunNode(void *arg) {
    auto *args = static_cast<NodeArgs *>(arg);
    __android_log_print(ANDROID_LOG_INFO, kLogTag, "Starting Node.js with %d arguments", args->argc);
    int exit_code = node::Start(args->argc, args->argv);
    __android_log_print(ANDROID_LOG_INFO, kLogTag, "Node.js exited with code %d", exit_code);
    fflush(stdout);
    fflush(stderr);
    NotifyExit(exit_code);
    // argv must stay valid for the lifetime of Node.js (libuv keeps pointers into it),
    // so it is intentionally not freed: the process ends after Node.js anyway.
    return nullptr;
}

std::string GetString(JNIEnv *env, jstring value) {
    if (value == nullptr) {
        return std::string();
    }
    const char *chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars != nullptr ? chars : "");
    if (chars != nullptr) {
        env->ReleaseStringUTFChars(value, chars);
    }
    return result;
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_ai_sillytavern_app_NodeBridge_nativeStart(JNIEnv *env, jclass clazz, jobjectArray arguments, jobjectArray environment, jstring log_path) {
    bool expected = false;
    if (!g_started.compare_exchange_strong(expected, true)) {
        return JNI_FALSE;
    }

    env->GetJavaVM(&g_vm);
    g_bridge_class = static_cast<jclass>(env->NewGlobalRef(clazz));
    g_on_exit = env->GetStaticMethodID(clazz, "onNodeExit", "(I)V");
    if (g_on_exit == nullptr) {
        env->ExceptionClear();
    }

    jsize env_count = environment != nullptr ? env->GetArrayLength(environment) : 0;
    for (jsize i = 0; i < env_count; i++) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(environment, i));
        std::string pair = GetString(env, item);
        env->DeleteLocalRef(item);
        size_t separator = pair.find('=');
        if (separator != std::string::npos && separator > 0) {
            setenv(pair.substr(0, separator).c_str(), pair.substr(separator + 1).c_str(), 1);
        }
    }

    RedirectOutput(GetString(env, log_path).c_str());

    // libuv requires all argv strings to live in one contiguous block of memory
    jsize argc = env->GetArrayLength(arguments);
    std::vector<std::string> values;
    size_t total_size = 0;
    for (jsize i = 0; i < argc; i++) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        values.push_back(GetString(env, item));
        env->DeleteLocalRef(item);
        total_size += values.back().size() + 1;
    }
    char *buffer = static_cast<char *>(calloc(total_size, sizeof(char)));
    auto **argv = static_cast<char **>(calloc(static_cast<size_t>(argc) + 1, sizeof(char *)));
    char *cursor = buffer;
    for (jsize i = 0; i < argc; i++) {
        memcpy(cursor, values[i].c_str(), values[i].size() + 1);
        argv[i] = cursor;
        cursor += values[i].size() + 1;
    }
    argv[argc] = nullptr;

    auto *node_args = new NodeArgs{static_cast<int>(argc), argv};
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, kNodeThreadStackSize);
    pthread_t thread;
    int result = pthread_create(&thread, &attr, RunNode, node_args);
    pthread_attr_destroy(&attr);
    if (result != 0) {
        __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Could not create the Node.js thread: %d", result);
        return JNI_FALSE;
    }
    pthread_detach(thread);
    return JNI_TRUE;
}
