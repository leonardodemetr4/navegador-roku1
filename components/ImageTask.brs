sub init()

    m.top.functionName =
        "runTask"

end sub


sub runTask()

    fileId =
        m.top.fileId


    if fileId = invalid or fileId = ""

        fileId =
            "0"

    end if


    localPath =
        "tmp:/pagina_" +
        fileId +
        ".png"


    transfer =
        CreateObject(
            "roUrlTransfer"
        )


    transfer.SetCertificatesFile(
        "common:/certs/ca-bundle.crt"
    )


    transfer.InitClientCertificates()


    transfer.SetUrl(
        m.top.url
    )


    transfer.AddHeader(
        "Cache-Control",
        "no-cache"
    )


    code =
        transfer.GetToFile(
            localPath
        )


    if code >= 200 and code < 300

        m.top.localUri =
            localPath

    else

        m.top.errorText =
            "Erro HTTP " +
            code.ToStr()

    end if

end sub
