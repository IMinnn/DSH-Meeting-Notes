// Windows 10/11 WASAPI shared-mode loopback. No screen capture, virtual driver,
// NuGet package or admin rights. Microphone consent/capture stays in the browser.
// Build with the .NET Framework 4.x csc.exe available on supported Windows hosts.
// Protocol: UTF-8 JSON line, then raw 16000 Hz mono signed Int16 little-endian.
// Windows hardware/driver behavior has NOT been validated on a Windows machine.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class MeetingLoopback
{
    private static readonly Guid AudioClientId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid CaptureClientId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid FloatFormat = new Guid("00000003-0000-0010-8000-00aa00389b71");
    private static readonly Guid PcmFormat = new Guid("00000001-0000-0010-8000-00aa00389b71");
    private static volatile bool stopping;

    [MTAThread]
    public static int Main(string[] args)
    {
        string command = args.Length == 1 ? args[0] : "";
        if (command != "probe" && command != "capture") {
            Console.Error.WriteLine("usage: mn-system-audio (probe|capture)"); return 64;
        }
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; stopping = true; };
        bool announced = false;
        IMMDeviceEnumerator enumerator = null;
        Session current = null;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            current = Session.Open(enumerator);
            if (command == "probe") {
                Json("{\"loopback\":\"ok\",\"backend\":\"wasapi\"}"); return 0;
            }
            // Nothing may write PCM until the handshake has been flushed.
            Json("{\"ready\":true,\"backend\":\"wasapi\"}"); announced = true;
            Stream output = Console.OpenStandardOutput();
            Stopwatch clock = Stopwatch.StartNew();
            long nextCheck = 0;
            long missingSince = -1;
            while (!stopping) {
                try {
                    if (clock.ElapsedMilliseconds >= nextCheck || current == null) {
                        nextCheck = clock.ElapsedMilliseconds + 1000;
                        string id = Session.DefaultId(enumerator);
                        if (current == null || id != current.DeviceId) {
                            if (current != null) { current.Dispose(); current = null; }
                            current = Session.Open(enumerator);
                            Console.Error.WriteLine("wasapi: bound to default multimedia output");
                        }
                    }
                    current.Drain(output);
                    missingSince = -1;
                    Thread.Sleep(5);
                } catch (COMException ex) {
                    // Endpoint unplug, audio service restart or format invalidation:
                    // preserve the stdout/SSE stream, reopen the current default.
                    Console.Error.WriteLine("wasapi: device unavailable 0x" + ex.ErrorCode.ToString("X8"));
                    if (current != null) { current.Dispose(); current = null; }
                    if (missingSince < 0) missingSince = clock.ElapsedMilliseconds;
                    if (clock.ElapsedMilliseconds - missingSince > 30000) throw;
                    Thread.Sleep(250);
                }
            }
            return 0;
        } catch (IOException) {
            // Parent closed its pipe (stop/quit); don't write another JSON header.
            return 0;
        } catch (Exception ex) {
            string detail = "wasapi-" + Marshal.GetHRForException(ex).ToString("X8");
            Console.Error.WriteLine(detail + ": " + ex.Message);
            if (!announced) Json("{\"error\":\"" + detail + "\"}");
            return 2;
        } finally {
            if (current != null) current.Dispose();
            Release(enumerator);
        }
    }

    private static void Json(string value) {
        byte[] line = Encoding.UTF8.GetBytes(value + "\n");
        Stream stdout = Console.OpenStandardOutput(); stdout.Write(line, 0, line.Length); stdout.Flush();
    }
    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    private static void Release(object value) {
        if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }

    private sealed class Session : IDisposable
    {
        internal string DeviceId;
        private IMMDevice device;
        private IAudioClient client;
        private IAudioCaptureClient capture;
        private int channels, rate, bits, align, validBits;
        private bool floating;
        private bool started;
        private Resampler resampler;

        internal static string DefaultId(IMMDeviceEnumerator enumerator) {
            IMMDevice value = null;
            try {
                Check(enumerator.GetDefaultAudioEndpoint(0, 1, out value)); // eRender, eMultimedia
                string id; Check(value.GetId(out id)); return id;
            } finally { Release(value); }
        }
        internal static Session Open(IMMDeviceEnumerator enumerator) {
            Session s = new Session();
            IntPtr format = IntPtr.Zero;
            try {
                Check(enumerator.GetDefaultAudioEndpoint(0, 1, out s.device));
                Check(s.device.GetId(out s.DeviceId));
                object obj; Guid iid = AudioClientId;
                Check(s.device.Activate(ref iid, 23, IntPtr.Zero, out obj)); // CLSCTX_ALL
                s.client = (IAudioClient)obj;
                Check(s.client.GetMixFormat(out format));
                int tag = (ushort)Marshal.ReadInt16(format, 0);
                s.channels = (ushort)Marshal.ReadInt16(format, 2);
                s.rate = Marshal.ReadInt32(format, 4);
                s.align = (ushort)Marshal.ReadInt16(format, 12);
                s.bits = (ushort)Marshal.ReadInt16(format, 14);
                s.validBits = s.bits;
                if (tag == 0xfffe) {
                    if ((ushort)Marshal.ReadInt16(format, 16) < 22) throw new NotSupportedException("short extensible audio format");
                    s.validBits = (ushort)Marshal.ReadInt16(format, 18);
                    byte[] guid = new byte[16]; Marshal.Copy(IntPtr.Add(format, 24), guid, 0, 16);
                    Guid sub = new Guid(guid);
                    if (sub == FloatFormat) tag = 3;
                    else if (sub == PcmFormat) tag = 1;
                    else throw new NotSupportedException("unsupported audio subformat " + sub);
                }
                s.floating = tag == 3;
                if (s.channels < 1 || s.channels > 32 || s.rate < 8000 || s.rate > 384000 ||
                    s.align != s.channels * (s.bits / 8) ||
                    (s.floating ? s.bits != 32 && s.bits != 64 : tag != 1 || (s.bits != 8 && s.bits != 16 && s.bits != 24 && s.bits != 32)))
                    throw new NotSupportedException("unsupported WASAPI mix format");
                // Shared mode, LOOPBACK only: no microphone or display capture.
                Check(s.client.Initialize(0, 0x00020000, 1000000, 0, format, IntPtr.Zero));
                iid = CaptureClientId;
                Check(s.client.GetService(ref iid, out obj)); s.capture = (IAudioCaptureClient)obj;
                s.resampler = new Resampler(s.rate);
                Check(s.client.Start()); s.started = true;
                Console.Error.WriteLine("wasapi: rate=" + s.rate + " channels=" + s.channels + " bits=" + s.bits);
                return s;
            } catch { s.Dispose(); throw; }
            finally { if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format); }
        }

        internal void Drain(Stream output) {
            uint next;
            Check(capture.GetNextPacketSize(out next));
            // Bound each pass so endpoint polling isn't starved by a busy driver.
            int packets = 0;
            while (next != 0 && packets++ < 200) {
                IntPtr data; uint frames, flags; ulong position, time;
                Check(capture.GetBuffer(out data, out frames, out flags, out position, out time));
                byte[] pcm;
                try {
                    if (frames > rate * 10) throw new InvalidDataException("oversized audio packet");
                    bool silent = (flags & 2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                    // GetBuffer's storage is valid only until ReleaseBuffer.
                    byte[] raw = new byte[checked((int)frames * align)];
                    if (!silent && raw.Length > 0) Marshal.Copy(data, raw, 0, raw.Length);
                    List<float> mono = new List<float>((int)frames);
                    for (int f = 0; f < frames; f++) {
                        double sum = 0;
                        if (!silent) for (int c = 0; c < channels; c++) sum += Sample(raw, f * align + c * (bits / 8));
                        mono.Add((float)(sum / channels));
                    }
                    pcm = resampler.Push(mono);
                } finally { Check(capture.ReleaseBuffer(frames)); }
                // Release the endpoint buffer before potentially blocking on stdout.
                if (pcm.Length > 0) output.Write(pcm, 0, pcm.Length);
                Check(capture.GetNextPacketSize(out next));
            }
        }
        private double Sample(byte[] raw, int at) {
            double value;
            if (floating) value = bits == 32 ? BitConverter.ToSingle(raw, at) : BitConverter.ToDouble(raw, at);
            else if (bits == 8) value = (raw[at] - 128) / 128.0;
            else if (bits == 16) value = BitConverter.ToInt16(raw, at) / 32768.0;
            else if (bits == 24) {
                int n = raw[at] | raw[at + 1] << 8 | raw[at + 2] << 16;
                value = (n << 8 >> 8) / 8388608.0;
            } else value = BitConverter.ToInt32(raw, at) / 2147483648.0;
            // Extensible integer valid bits are left-aligned, so container scaling
            // above already handles e.g. 24 significant bits in a 32-bit container.
            return Double.IsNaN(value) || Double.IsInfinity(value) ? 0 : Math.Max(-1, Math.Min(1, value));
        }
        public void Dispose() {
            if (started && client != null) { client.Stop(); started = false; }
            Release(capture); capture = null;
            Release(client); client = null;
            Release(device); device = null;
        }
    }

    // Streaming 32-tap Blackman-windowed sinc; preserves fractional phase and
    // history across packets (44.1/48/96 kHz etc.). No NuGet DSP dependency.
    internal sealed class Resampler
    {
        private readonly double ratio, cutoff;
        private readonly List<float> samples = new List<float>();
        private long first, next;
        internal Resampler(int rate) { ratio = rate / 16000.0; cutoff = Math.Min(.5, .5 / ratio) * .92; }
        internal byte[] Push(List<float> input) {
            samples.AddRange(input);
            using (MemoryStream output = new MemoryStream()) {
                while (true) {
                    double t = next * ratio; long b = (long)t; double fraction = t - b;
                    if (b + 16 >= first + samples.Count) break;
                    double acc = 0;
                    for (int k = -15; k <= 16; k++) {
                        long index = b + k;
                        double sample = index < first ? 0 : samples[(int)(index - first)];
                        double x = k - fraction, p = Math.PI * 2 * cutoff * x;
                        double sinc = Math.Abs(p) < 1e-8 ? 1 : Math.Sin(p) / p;
                        double window = .42 + .5 * Math.Cos(Math.PI * x / 17) + .08 * Math.Cos(2 * Math.PI * x / 17);
                        acc += sample * 2 * cutoff * sinc * window;
                    }
                    short n = (short)Math.Max(-32768, Math.Min(32767, (int)(acc * 32767)));
                    output.WriteByte((byte)(n & 255)); output.WriteByte((byte)((n >> 8) & 255)); next++;
                }
                long keep = (long)(next * ratio) - 17;
                int remove = (int)Math.Max(0, Math.Min(samples.Count, keep - first));
                if (remove > 0) { samples.RemoveRange(0, remove); first += remove; }
                return output.ToArray();
            }
        }
    }

    // COM declarations preserve SDK vtable order, including unused methods.
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient {
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
